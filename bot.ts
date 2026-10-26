import {
  AccountInfo,
  Commitment,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Signer,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import * as dotenv from "dotenv";
import {
  sendTransactionWithRetry,
  TransactionPendingError,
} from "./transaction";
import { z } from "zod";
import vaultInvoicerIDL from "./IDL/vaultInvoicer.json";
import liquidUnstakerIDL from "./IDL/liquidUnstaker.json";
import BigNumber from "bignumber.js";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import {
  Provider,
  SignerWallet,
  SolanaProvider,
} from "@saberhq/solana-contrib";
import {
  ChainId,
  getATAAddressSync,
  getOrCreateATA,
  Token,
} from "@saberhq/token-utils";
import { zPublicKey } from "./zodSolana";

const FIRST_INVOICE_EPOCH = 780;

dotenv.config();

const {
  RPC_URL,
  VOTE_KEY,
  PRIVATE_KEY,
  LIST_ONLY,
  MAX_INVOICES_PER_RUN,
  LOOKBACK_EPOCHS,
  INVOICERS,
} = process.env;

if (!RPC_URL) {
  throw Error("No RPC URL set");
}
if (!VOTE_KEY) {
  throw Error("No VOTE_KEY set");
}

const listOnly = LIST_ONLY === "1" || LIST_ONLY === "true";

if (!PRIVATE_KEY && !listOnly) {
  throw Error("No PRIVATE_KEY set");
}

/**
 * A feed invoice row for a validator (SolanaVault/stake-as-a-service-data
 * <epoch>/invoices.json, frozen contract). There is one invoice per validator
 * per epoch per invoicer — a validator may hold several invoices in the same
 * epoch when several invoicers bill it (SaaS + community pool).
 *
 * Billing cut over from vSOL to VLP at epoch 1064; live rows are mint-aware:
 * a NEW row ALWAYS carries `amount` (in `paymentMint` base units) plus
 * `paymentMint` = the VLP mint (EUWoTx5vQQrxaDFdeK2PLUVbnmRWjw4x6sBbmcxBaHjF)
 * plus `quoteRate`/`quoteSlot`. A row WITHOUT `paymentMint` is a legacy vSOL
 * row: display-only history — never pay it, never route it, skip with a
 * warning. A row whose `paymentMint` is present but is NOT the VLP mint is
 * likewise a legacy row and skipped. `amount`/`paymentMint` are optional for
 * exactly that legacy parseability and nothing more.
 */
export const zValidatorInvoice = z.object({
  // The vote key of the validator
  validatorVoteKey: zPublicKey,
  // The epoch for which the invoice is valid
  epoch: z.number().int(),
  // The amount of undirected stake in the validator in lamports
  stakeLamports: z.coerce.bigint(),
  // The price per 1000 SOL in lamports that this validator is charged
  pricePer1KSol: z.coerce.bigint(),
  // Amount to pay (payment-mint units, canonical). Legacy vSOL rows omit it.
  amount: z.coerce.bigint().optional(),
  // The mint `amount` is denominated in; absent => legacy vSOL row (skip).
  paymentMint: zPublicKey.optional(),
  paymentMintDecimals: z.coerce.number().int().min(0).max(12).optional(),
  // SOL/quote rate used to price the invoice, and the slot it was read at
  quoteRate: z.coerce.number().optional(),
  quoteSlot: z.coerce.bigint().optional(),
  // Community-pool billing (same semantics, pool-side)
  poolStakeLamports: z.coerce.bigint().optional(),
  poolPricePer1KSol: z.coerce.bigint().optional(),
  // Pool fee in `paymentMint` base units (counterpart of `amount`)
  poolAmount: z.coerce.bigint().optional(),
});

export interface Invoice {
  address: PublicKey;
  invoicer: PublicKey;
  voteAccount: PublicKey;
  epoch: number;
  /**
   * The on-chain `amount_vsol` field — a historical misnomer: it carries the
   * amount in the invoicer's (VLP) payment mint. Kept as `amount` here; the
   * IDL/program field name stays `amount_vsol`.
   */
  amount: bigint;
  balanceOutstanding: bigint;
}

/**
 * The Invoicer account of an invoice, decoded from its raw bytes.
 *
 * The payment token of an invoice is the `mint` of the invoicer that issued
 * it — the on-chain source of truth (an invoice carries no mint; the
 * program rejects a source account of any other mint with
 * `InvalidSourceMint`). Billing settled in VLP at epoch 1064 and this bot
 * pays VLP only; an invoicer predating the mint field (272 B layout, or a
 * zeroed mint) is retired legacy vSOL machinery and fails loud.
 *
 * The 304 B layout is: [8 anchor disc][base_key 32][bump][_padding 6]
 * [vsol_reserves 32 -> @48][... authority fields ...][mint 32 -> @272].
 * `vsol_reserves` is the program's misnomer for the payment-mint reserves
 * ATA. Verified against the live VLP invoicers.
 */
export interface InvoicerInfo {
  address: PublicKey;
  mint: PublicKey;
  reserves: PublicKey;
}

const INVOICE_DISCRIMINATOR_LEN = 8;

const invoiceParser = {
  programID: new PublicKey(vaultInvoicerIDL.address),
  name: "Invoice",
  parse: (address: PublicKey, data: Buffer): Invoice => {
    const invoicer = new PublicKey(data.subarray(8, 40));
    const voteAccount = new PublicKey(data.subarray(40, 40 + 32));
    const view = new DataView(data.buffer, data.byteOffset + 72, 8 * 3);
    const epoch = Number(view.getBigUint64(0, true));
    const amount = view.getBigUint64(8, true);
    const balanceOutstanding = view.getBigUint64(16, true);

    return {
      address,
      invoicer,
      voteAccount,
      epoch,
      amount,
      balanceOutstanding,
    };
  },
};

export type ValidatorInvoice = z.infer<typeof zValidatorInvoice>;

const findInvoiceAddress = (
  invoicer: PublicKey,
  voteAccount: PublicKey,
  epoch: number,
) => {
  const [key] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("invoice"),
      invoicer.toBytes(),
      voteAccount.toBytes(),
      (() => {
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer, 0, 8);
        view.setBigUint64(0, BigInt(epoch), true);
        return new Uint8Array(buffer);
      })(),
    ],
    invoiceParser.programID,
  );
  return key;
};

/**
 * The liquid unstaker is the program that mints VLP: `deposit_sol` credits
 * VLP to the payer's ATA instantly for a SOL transfer. VLP is the reward
 * mint of the VLP community pool, and the VLP-denominated invoicers settle
 * invoices in it — so this is the SOL -> VLP route for wallets that hold
 * only SOL.
 */
const LIQUID_UNSTAKER_PROGRAM = new PublicKey(
  "2rU1oCHtQ7WJUvy15tKtFvxdYNNSc3id7AzUcjeFSddo",
);
const LIQUID_UNSTAKER_POOL = new PublicKey(
  "9nyw5jxhzuSs88HxKJyDCsWBZMhxj2uNXsFcyHF5KBAb",
);
const VLP_MINT = new PublicKey(
  "EUWoTx5vQQrxaDFdeK2PLUVbnmRWjw4x6sBbmcxBaHjF",
);

export const VLP_TOKEN_OBJ = new Token({
  name: "Vault Unstake LP",
  address: VLP_MINT.toBase58(),
  decimals: 9,
  symbol: "VLP",
  chainId: ChainId.MainnetBeta,
});

/**
 * TRUSTED invoicers. Creating an invoicer is permissionless (`create_invoicer`
 * takes any base key + any settlement mint) and invoices can be created for
 * any vote account bytes by whoever owns an invoicer's `invoice_creator` key
 * — so anyone can mint you an invoice for any amount. The on-chain scan
 * therefore discovers aggressively, but this bot only ever PAYS invoices
 * issued by invoicers on this list (Vault-operated SaaS + community-pool VLP
 * invoicers). The vSOL-era invoicers were retired at the epoch-1064 billing
 * cutover: their open invoices are dead legacy debt The Vault handles
 * separately, and the bot never pays vSOL. The list doubles as the PDA
 * fallback source of invoices for scan-less RPCs. Update `INVOICERS`
 * (comma-separated) when The Vault introduces a new invoicer.
 */
const KNOWN_INVOICERS = [
  "9HE9R14dazhR1rz6Vamap7zTzkVihqiWVk5nS447PB6F", // community pool, VLP
  "DzWNQFv5FPVwpiSehxDJJ8KMMMp89XEjVswsAmqB5ARF", // SaaS, VLP
];

const invoicerCandidates = (): PublicKey[] =>
  (INVOICERS ?? KNOWN_INVOICERS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new PublicKey(s));

/**
 * Invoices from invoicers outside the trusted list are skipped entirely (and
 * said so loudly) — they are indistinguishable from spam/invoice-harvesting
 * attempts. Set ALLOW_UNTRUSTED_INVOICERS=1 only if The Vault rotated an
 * invoicer and you verified its address through official channels.
 */
const TRUSTED_INVOICERS = new Set(invoicerCandidates().map((p) => p.toBase58()));
const allowUntrusted = process.env.ALLOW_UNTRUSTED_INVOICERS === "1";

export const connection = new Connection(RPC_URL);

const makeInvoicerProgram = (provider: AnchorProvider) =>
  new Program(vaultInvoicerIDL as any, provider);

export const makeLiquidUnstakerProgram = (provider: AnchorProvider) =>
  new Program(liquidUnstakerIDL as any, provider);

/**
 * Lists all invoices of this bot's validator across every trusted invoicer
 * (SaaS + community pool, both VLP), primary path a program account scan
 * filtered by the vote account at its known offset; fallback derives the
 * invoice PDAs for the epochs window over `INVOICERS`.
 * Returns them oldest-first so no invoice ages out unpaid.
 */
export const getInvoices = async (voteAccount: PublicKey): Promise<Invoice[]> => {
  const epochInfo = await connection.getEpochInfo();
  const currentEpoch = epochInfo.epoch;
  const lookback = Number(LOOKBACK_EPOCHS ?? 20);
  const minEpoch = Math.max(
    FIRST_INVOICE_EPOCH,
    currentEpoch - Math.max(1, lookback),
  );

  const inWindow = (i: Invoice) => i.epoch >= minEpoch && i.epoch <= currentEpoch;

  let invoices: Invoice[];
  try {
    if (process.env.FORCE_PDA_FALLBACK) {
      throw Error("FORCE_PDA_FALLBACK set");
    }
    const accounts = await connection.getProgramAccounts(invoiceParser.programID, {
      filters: [
        { dataSize: 96 },
        { memcmp: { offset: 40, bytes: voteAccount.toBase58() } },
      ],
    });
    invoices = accounts.map((a) => invoiceParser.parse(a.pubkey, a.account.data));
  } catch (e: any) {
    console.log(
      `Program scan failed (${e.message}); falling back to invoice PDAs of the known invoicers.`,
    );
    const epochs: number[] = [];
    for (let e = minEpoch; e <= currentEpoch; e++) epochs.push(e);
    const addresses: PublicKey[] = [];
    for (const invoicer of invoicerCandidates()) {
      for (const epoch of epochs) {
        addresses.push(findInvoiceAddress(invoicer, voteAccount, epoch));
      }
    }
    const infos = await connection.getMultipleAccountsInfo(addresses);
    invoices = infos
      .map((info, i): Invoice | null =>
        info ? invoiceParser.parse(addresses[i], info.data) : null,
      )
      .filter((x): x is Invoice => !!x);
  }

  return invoices
    .filter(inWindow)
    .filter((i) => i.balanceOutstanding > 0 && i.amount > 0)
    .sort((a, b) => a.epoch - b.epoch);
};

/**
 * Decides the payment mint + reserves account of an invoicer from its raw
 * account bytes: only the 304 B mint-aware layout — its mint at @272, its
 * reserves ATA at @42+6 (anchor's explicit `_padding [u8; 6]` after the PDA
 * bump aligns `vsol_reserves` to @48). A 272 B account predates the mint
 * field, and a 304 B account with a zeroed @272 mint predates mint-aware
 * settlement: both are the retired vSOL era's layout. The bot is pointed
 * only at mint-aware VLP invoicers, so either one is an unexpected legacy
 * vSOL invoicer — stop loudly rather than pay in vSOL. Anything else is
 * program drift.
 */
const RESERVES_OFFSET = 48;
const MINT_OFFSET = 272;

const resolveInvoicer = async (address: PublicKey): Promise<InvoicerInfo> => {
  const info = await connection.getAccountInfo(address);
  if (!info) throw Error(`Invoicer ${address.toBase58()} not found`);
  const data = info.data;
  if (data.length !== 304) {
    throw Error(
      `Unexpected Invoicer account size ${data.length} for ${address.toBase58()} — ` +
        `this bot understands only the 304 B (mint-aware) layout; a ${data.length} B pre-mint account is an unexpected legacy vSOL invoicer, and vSOL payments were removed (billing cut over to VLP at epoch 1064).`,
    );
  }
  const mintBytes = data.subarray(MINT_OFFSET, MINT_OFFSET + 32);
  if (mintBytes.every((b) => b === 0)) {
    throw Error(
      `unexpected legacy vSOL invoicer ${address.toBase58()} (zeroed mint at @${MINT_OFFSET}) — ` +
        `the vSOL invoicers were retired at the epoch-1064 billing cutover; this bot pays VLP only.`,
    );
  }
  const mint = new PublicKey(mintBytes);
  const reserves = new PublicKey(data.subarray(RESERVES_OFFSET, RESERVES_OFFSET + 32));

  // Self-check the offsets against the reserves ATA itself: it must be a
  // token account whose mint is the invoicer's mint for what we pay.
  const reservesInfo = await connection.getAccountInfo(reserves);
  if (!reservesInfo || reservesInfo.data.length < 64 || reservesInfo.owner.toBase58() !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
    throw Error(
      `Reserves account ${reserves.toBase58()} of ${address.toBase58()} is not an SPL token account — layout offsets wrong?, refusing to pay.`,
    );
  }
  const reservesMint = new PublicKey(reservesInfo.data.subarray(0, 32));
  if (!reservesMint.equals(mint)) {
    throw Error(
      `Reserves ATA mint ${reservesMint.toBase58()} != invoicer mint ${mint.toBase58()} for ${address.toBase58()} — layout offsets wrong, refusing to pay.`,
    );
  }

  return { address, mint, reserves };
};

export const getInvoicerInfos = async (invoices: Invoice[]) => {
  const cache = new Map<string, InvoicerInfo>();
  for (const invoice of invoices) {
    const key = invoice.invoicer.toBase58();
    if (!cache.has(key)) {
      cache.set(key, await resolveInvoicer(invoice.invoicer));
    }
  }
  return cache;
};

/**
 * Token balance of an owner, by default at 'confirmed'. The RPC default
 * ('finalized') lags a just-confirmed transfer by tens of seconds — reading
 * post-funding balances that way made a landed purchase look like zero and the
 * run skipped paying invoices it could have paid.
 */
export const getTokenBalance = async (
  owner: PublicKey,
  mint: PublicKey,
  commitment: Commitment = "confirmed",
) => {
  const accounts = await connection.getTokenAccountsByOwner(
    owner,
    { mint },
    commitment,
  );
  return accounts.value.reduce(
    (acc, a) =>
      acc + Number(a.account.data.readBigUInt64LE(64)) / 10 ** 9,
    0,
  );
};

/**
 * The liquid unstaker's SOL -> VLP route: `deposit_sol` mints VLP straight
 * into the payer's VLP ATA. Mirrors the dapp's buildDepositSolInstructions.
 */
export const buildDepositSolInstructions = async (
  program: Program,
  provider: Provider,
  user: PublicKey,
  amount: BN,
) => {
  const [solVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("sol_vault"), LIQUID_UNSTAKER_POOL.toBuffer()],
    program.programId,
  );
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint"), LIQUID_UNSTAKER_POOL.toBuffer()],
    program.programId,
  );
  const [inventorySummary] = PublicKey.findProgramAddressSync(
    [Buffer.from("inventory_summary"), LIQUID_UNSTAKER_POOL.toBuffer()],
    program.programId,
  );

  const userLpAccount = await getOrCreateATA({
    provider,
    mint: lpMint,
    owner: user,
  });

  const depositIx = await program.methods
    .depositSol(amount)
    .accounts({
      pool: LIQUID_UNSTAKER_POOL,
      user,
      solVault,
      lpMint,
      userLpAccount: userLpAccount.address,
      inventorySummary,
      clock: new PublicKey("SysvarC1ock11111111111111111111111111111111"),
      // Anchor >=0.30 accepts only PublicKey|string per account (see
      // InstructionNamespaceFactory.accountsArray -> translateAddress); the
      // old `{pubkey, isSigner, isWritable}` meta objects throw client-side
      // with 'Wrong input type for account "systemProgram"'. Mirrors the
      // dapp's buildDepositSolInstructions.
      systemProgram: SystemProgram.programId,
      tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    })
    .instruction();

  return {
    instructions: [userLpAccount.instruction, depositIx].filter(
      (i): i is TransactionInstruction => !!i,
    ),
  };
};

/**
 * Price of one VLP in SOL, from the unstake pool account:
 * (SOL in the vault + deactivating stake lamports) / circulating VLP.
 * Deliberately a floor — the pool also holds LST inventory not counted here
 * — the funded SOL amount adds a margin on top of it, which only ever buys
 * extra VLP balance usable by later invoices.
 */
export const getVLPPriceSol = async () => {
  const provider = new AnchorProvider(
    connection,
    { publicKey: PublicKey.default } as any,
    { commitment: "confirmed" },
  );
  const pool = await makeLiquidUnstakerProgram(provider).account.pool.fetch(
    LIQUID_UNSTAKER_POOL,
  );
  const totalLpTokens = new BigNumber(pool.totalLpTokens.toString());
  if (totalLpTokens.isZero()) {
    return null;
  }
  return new BigNumber(pool.solVaultLamports.toString())
    .plus(pool.totalDeactivatingStake.toString())
    .div(totalLpTokens)
    .toNumber();
};

const payInvoices = async () => {
  const payer = PRIVATE_KEY
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(PRIVATE_KEY)))
    : null;

  // Get invoices that need to be paid
  const invoices = await getInvoices(new PublicKey(VOTE_KEY));

  // Security gate: only invoices from invoicers on the trusted list (or an
  // explicit opt-in) are ever paid — see KNOWN_INVOICERS docs above. Anyone
  // can create an invoicer and bill any vote account on-chain.
  const isTrusted = (i: Invoice) => TRUSTED_INVOICERS.has(i.invoicer.toBase58());
  const trusted = allowUntrusted ? invoices : invoices.filter(isTrusted);
  const untrusted = invoices.filter((i) => !isTrusted(i));
  const untrustedSkipped = [
    ...untrusted
      .reduce((m, i) => {
        const k = i.invoicer.toBase58();
        const e = m.get(k) ?? { invoicer: k, count: 0, epochs: [] as number[], amountTokens: 0 };
        e.count += 1;
        e.epochs.push(i.epoch);
        e.amountTokens += Number(i.amount) / 10 ** 9;
        return m.set(k, e);
      }, new Map<string, (typeof untrustedSkipped)[number]>())
      .values(),
  ];
  if (untrusted.length) {
    console.log(
      `${allowUntrusted ? "WARNING: paying" : "SECURITY: refusing to pay"} invoice(s) from invoicer(s) outside the trusted list: ${untrustedSkipped
        .map((u) => `${u.invoicer} (${u.count} invoice(s), epochs ${u.epochs.join(",")}, ${u.amountTokens} tokens)`)
        .join("; ")}. ${allowUntrusted ? "ALLOW_UNTRUSTED_INVOICERS is set." : "CreateInvoicer is permissionless — verify with The Vault before adding it to INVOICERS."}`,
    );
  }

  const invoicerInfos = await getInvoicerInfos(trusted);

  // The trusted list holds only mint-aware VLP invoicers, so every trusted
  // invoice must settle in the VLP mint. If one somehow resolves to a
  // non-VLP mint, throw loudly — the invoicer-list filter makes this
  // unreachable, and paying any other token is not an option (the vSOL
  // payment path is gone).
  for (const invoice of trusted) {
    const mint = invoicerInfos.get(invoice.invoicer.toBase58())!.mint;
    if (!mint.equals(VLP_TOKEN_OBJ.mintAccount)) {
      throw Error(
        `Invoice ${invoice.address.toBase58()} (epoch ${invoice.epoch}) of invoicer ${invoice.invoicer.toBase58()} settles in ${mint.toBase58()}, not the VLP mint ${VLP_TOKEN_OBJ.mintAccount.toBase58()} — the vSOL payment path has been removed; refusing to pay.`,
      );
    }
  }
  const payable = trusted;

  const maxPerRun = Number(MAX_INVOICES_PER_RUN ?? 10);
  const due = payable.slice(0, maxPerRun);
  const provider = payer
    ? SolanaProvider.init({ connection, wallet: new SignerWallet(payer) })
    : null;

  // Balances + planned top-ups per payment token
  const dueByMint = new Map<string, { mint: PublicKey; amount: bigint }>();
  for (const invoice of due) {
    const mint = invoicerInfos.get(invoice.invoicer.toBase58())!.mint;
    const entry = dueByMint.get(mint.toBase58()) ?? { mint, amount: 0n };
    entry.amount += invoice.amount;
    dueByMint.set(mint.toBase58(), entry);
  }

  const balances = new Map<string, number>();
  const balanceOwner = payer?.publicKey ?? PublicKey.default;
  const readBalances = async () => {
    for (const { mint } of dueByMint.values()) {
      balances.set(mint.toBase58(), await getTokenBalance(balanceOwner, mint));
    }
  };
  await readBalances();

  let vlpPriceSol: number | null = null;
  try {
    vlpPriceSol = await getVLPPriceSol();
  } catch (e: any) {
    console.log(`VLP price unavailable: ${e.message}`);
  }

  // Plan view: what is due in VLP, what the wallet holds, and roughly how
  // much SOL a top-up needs (VLP: floor price + 30% margin). Listing only —
  // funding instructions are built during a real run so LIST never signs.
  const plan = [...dueByMint.values()].map(({ mint, amount }) => {
    const dueTokens = Number(amount) / 10 ** 9;
    const balance = balances.get(mint.toBase58()) ?? 0;
    const deficit = Math.max(0, dueTokens - balance);
    return {
      mint: mint.toBase58(),
      due: dueTokens,
      balance,
      fundSol:
        vlpPriceSol && deficit > 0 ? deficit * vlpPriceSol * 1.3 : 0,
    };
  });

  console.log(
    JSON.stringify(
      {
        vote: VOTE_KEY,
        invoices: due.map((i) => ({
          address: i.address.toBase58(),
          invoicer: i.invoicer.toBase58(),
          mint: invoicerInfos.get(i.invoicer.toBase58())!.mint.toBase58(),
          epoch: i.epoch,
          amountTokens:
            Number(i.amount) / 10 ** 9,
          balanceOutstandingTokens:
            Number(i.balanceOutstanding) / 10 ** 9,
        })),
        funding: plan,
      },
      null,
      2,
    ),
  );

  if (listOnly) {
    if (due.length) {
      // Still exercise building the pay instructions so `LIST_ONLY=1` catches
      // account-layout drift without ever signing anything.
      await buildPayChunks(
        makeInvoicerProgramReadOnly(),
        due,
        invoicerInfos,
        balanceOwner,
      );
      console.log("LIST_ONLY — instruction building verified, nothing sent.");
    } else {
      console.log("LIST_ONLY — no unpaid invoices.");
    }
    process.exit(0);
  }

  if (!due.length) {
    console.log("No invoices to pay");
    process.exit(0);
  }

  // Top-up plan (mint -> SOL spent) + a funding tx that was broadcast but
  // never confirmed, hoisted so the pay decision below can consult both.
  const fundingSol = new Map<string, number>();
  let fundingUnsettled: { sig: string; reason: string } | null = null;

  if (payer && provider) {
    // Top up payment tokens that are short, as one funding transaction, then
    // re-read balances AT 'confirmed' once the tx is confirmed (never make the
    // pay decision off a pre-funding read). A token we cannot fund (price
    // oracle down, deposit caps, no SOL) only costs its invoices this run.
    const fundingIxs: TransactionInstruction[] = [];
    const fundingSigners: Signer[] = [];
    for (const { mint, amount } of dueByMint.values()) {
      const dueTokens = Number(amount) / 10 ** 9;
      const balance = balances.get(mint.toBase58()) ?? 0;
      if (balance >= dueTokens) continue;
      const deficit = dueTokens - balance;
      try {
        if (mint.equals(VLP_TOKEN_OBJ.mintAccount)) {
          if (!vlpPriceSol)
            throw new Error("VLP price unavailable (unstake pool LP supply is zero?)");
          const lamports = Math.ceil(deficit * vlpPriceSol * 1.3 * 10 ** 9);
          const ixs = await buildDepositSolInstructions(
            makeLiquidUnstakerProgram(
              new AnchorProvider(connection, new SignerWallet(payer)),
            ),
            provider,
            payer.publicKey,
            new BN(lamports),
          );
          fundingIxs.push(...ixs.instructions);
          fundingSol.set(mint.toBase58(), lamports / LAMPORTS_PER_SOL);
        } else {
          // Unreachable: the mint check above in payInvoices already threw
          // for anything but VLP. Loud, never silent.
          throw Error(
            `Cannot fund ${mint.toBase58()}: the only fundable payment mint is VLP (${VLP_TOKEN_OBJ.mintAccount.toBase58()}).`,
          );
        }
      } catch (e: any) {
        console.log(`Cannot fund ${mint.toBase58()} this run: ${e.message}`);
      }
    }
    if (fundingIxs.length) {
      const needed = [...fundingSol.values()].reduce((a, b) => a + b, 0);
      const solBalance =
        (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
      if (solBalance < needed + 0.005) {
        console.log(
          `Wallet SOL ${solBalance.toFixed(4)} < funding ${needed.toFixed(4)} + fees — skipping top-ups.`,
        );
      } else {
        console.log(
          `Funding: ${[...fundingSol].map(([m, s]) => `${s.toFixed(4)} SOL -> ${m}`).join(", ")}`,
        );
        try {
          await sendTransactionWithRetry(
            connection,
            fundingIxs,
            [...fundingSigners],
            payer,
            [],
            0,
            {
              // Re-broadcast an UNSETTLED funding tx only while some bought
              // token is still confirmed-short — if the (confirmed) balance
              // already covers the due amount, the tx landed after our poll
              // gave up, and re-sending would buy the tokens a second time.
              preRebroadcast: async () => {
                let stillShort = false;
                for (const mintB58 of fundingSol.keys()) {
                  const g = dueByMint.get(mintB58)!;
                  const bal = await getTokenBalance(payer.publicKey, g.mint);
                  if (bal < Number(g.amount) / 10 ** 9) stillShort = true;
                  else balances.set(mintB58, bal);
                }
                return stillShort;
              },
            },
          );
        } catch (e: any) {
          fundingUnsettled = {
            sig:
              e instanceof TransactionPendingError && e.signature
                ? e.signature
                : "no-settled-tx",
            reason: e?.message ?? String(e),
          };
          console.log(
            `Funding tx not confirmed (${fundingUnsettled.reason}) — re-checking balances at 'confirmed' before deciding.`,
          );
        }
        // Always re-read at 'confirmed': covers a landed funding tx the poll
        // timed out on, and never pays off the pre-funding (stale) read.
        await readBalances();
      }
    }
  }

  // Pay (in chunks of 8 invoices) only what the token balances now cover.
  const covered = (invoice: Invoice) => {
    const g = dueByMint.get(
      invoicerInfos.get(invoice.invoicer.toBase58())!.mint.toBase58(),
    )!;
    return (balances.get(g.mint.toBase58()) ?? 0) >= Number(g.amount) / 10 ** 9;
  };
  const payableNow = due.filter(covered);
  if (payableNow.length < due.length) {
    console.log(
      `Still short, skipping: ${due
        .filter((i) => !covered(i))
        .map(
          (i) =>
            `${i.epoch} (${invoicerInfos.get(i.invoicer.toBase58())!.mint.toBase58()})`,
        )
        .join(", ")}`,
    );
  }
  // A funding tx that never settled: name the mint + signature so the skip is
  // traceable. If it lands after this run, the next run sees the bought balance
  // and pays without re-funding; if it truly died, the next run funds again.
  if (fundingUnsettled) {
    for (const mintB58 of fundingSol.keys()) {
      if (
        payableNow.some(
          (i) =>
            invoicerInfos.get(i.invoicer.toBase58())!.mint.toBase58() ===
            mintB58,
        )
      )
        continue;
      console.log(
        `funding ${mintB58}: tx ${fundingUnsettled.sig} still pending — invoices deferred to next run`,
      );
    }
  }
  if (!payableNow.length) {
    console.log("Nothing payable this run.");
    process.exit(0);
  }

  const program = makeInvoicerProgram(
    new AnchorProvider(connection, new SignerWallet(payer!)),
  );
  const chunks = await buildPayChunks(
    program,
    payableNow,
    invoicerInfos,
    payer!.publicKey,
  );
  for (const [ci, chunk] of chunks.entries()) {
    console.log(`Paying chunk ${ci + 1}/${chunks.length}...`);
    const chunkInvoices = payableNow.slice(ci * 8, ci * 8 + 8);
    const hash = await sendTransactionWithRetry(
      connection,
      chunk,
      [payer!],
      payer!,
      [],
      0,
      {
        // Re-send an UNSETTLED pay tx only while every invoice it covers is
        // still outstanding at 'confirmed' — a broadcast that landed after the
        // poll gave up must not be paid twice.
        preRebroadcast: async () => {
          for (const inv of chunkInvoices) {
            const info = await connection.getAccountInfo(
              inv.address,
              "confirmed",
            );
            if (!info || info.data.readBigUInt64LE(88) > 0n) return true;
          }
          return false;
        },
      },
    );
    console.log(hash);
  }
  console.log(
    `Paid ${payableNow.length} invoice(s): ${payableNow.map((i) => i.epoch).join(", ")}`,
  );
};

export const makeInvoicerProgramReadOnly = () =>
  makeInvoicerProgram(
    new AnchorProvider(
      connection,
      { publicKey: PublicKey.default } as any,
      { commitment: "confirmed" },
    ),
  );

export const buildPayChunks = async (
  program: Program,
  invoices: Invoice[],
  invoicerInfos: Map<string, InvoicerInfo>,
  payerKey: PublicKey,
) => {
  const chunks: TransactionInstruction[][] = [];
  for (let i = 0; i < invoices.length; i += 8) {
    const chunk = await Promise.all(
      invoices.slice(i, i + 8).map(async (invoice) => {
        const info = invoicerInfos.get(invoice.invoicer.toBase58())!;
        return program.methods
          // The IDL arg is still named `amount_vsol` — a misnomer; it carries
          // the amount in the invoicer's payment mint (VLP).
          .payInvoice(new BN(invoice.amount.toString()))
          .accountsPartial({
            // The parsed invoice carries the invoicer that issued it, so a
            // pool invoice pays into the pool's invoicer and a SaaS invoice
            // into the production one, with no branch here — every invoice
            // settles from the payer's VLP ATA. `vsolReserves` is the IDL's
            // misnomer for the invoicer's payment-mint reserves ATA.
            invoicer: invoice.invoicer,
            invoice: invoice.address,
            source: getATAAddressSync({
              mint: info.mint,
              owner: payerKey,
            }),
            sourceAuthority: payerKey,
            vsolReserves: info.reserves,
          })
          .instruction();
      }),
    );
    chunks.push(chunk);
  }
  return chunks;
};

// Importable without auto-running (selftest.ts reuses the builders above).
if (require.main === module) {
  payInvoices();
}
