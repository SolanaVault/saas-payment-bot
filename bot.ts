import {
  AccountInfo,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Signer,
  TransactionInstruction,
} from "@solana/web3.js";
import * as dotenv from "dotenv";
import { sendTransactionWithRetry } from "./transaction";
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
import { depositSol, stakePoolInfo } from "@solana/spl-stake-pool";
import { zPublicKey } from "@thevault/zod-solana";

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
 * An invoice for a validator. There is one invoice per validator per epoch
 * per invoicer — a validator may hold several invoices in the same epoch
 * when several invoicers bill it (SaaS + community pool, vSOL + VLP twins).
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
  // Amount to pay for the validator (denominated in the invoicer's mint)
  amountVSol: z.coerce.bigint(),
});

interface Invoice {
  address: PublicKey;
  invoicer: PublicKey;
  voteAccount: PublicKey;
  epoch: number;
  amountVsol: bigint;
  balanceOutstanding: bigint;
}

/**
 * The Invoicer account of an invoice, decoded from its raw bytes.
 *
 * The payment token of an invoice is the `mint` of the invoicer that issued
 * it — the on-chain source of truth (an invoice carries no mint; the
 * program rejects a source account of any other mint with
 * `InvalidSourceMint`). Invoicers predating the mint field were always paid
 * in vSOL, so an invoicer without the trailing mint field reads as vSOL.
 *
 * The 304 B layout is: [8 anchor disc][base_key 32][bump][_padding 6]
 * [vsol_reserves 32 -> @48][... authority fields ...][vsol invoicer data ...]
 * [mint 32 -> @272]. Verified against the live vSOL and VLP invoicers.
 */
interface InvoicerInfo {
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
    const amountVsol = view.getBigUint64(8, true);
    const balanceOutstanding = view.getBigUint64(16, true);

    return {
      address,
      invoicer,
      voteAccount,
      epoch,
      amountVsol,
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

const STAKE_POOL_ADDRESS = "Fu9BYC6tWBo1KMKaP3CFoKfRhqv9akmy3DuYwnCyWiyC";
const STAKE_POOL_MINT = "vSoLxydx6akxyMD9XEcPvGYNGq6Nn66oqVb3UkGkei7";

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

const VSOL_TOKEN_OBJ = new Token({
  name: "Vault SOL",
  logoURI:
    "https://gateway.irys.xyz/DTBps6awrJWectiBhMubYke4TBnE9kkVqyCVP4MB4irB",
  address: STAKE_POOL_MINT.toString(),
  decimals: 9,
  symbol: "vSOL",
  chainId: ChainId.MainnetBeta,
});

const VLP_TOKEN_OBJ = new Token({
  name: "Vault Unstake LP",
  address: VLP_MINT.toBase58(),
  decimals: 9,
  symbol: "VLP",
  chainId: ChainId.MainnetBeta,
});

const TOKENS: Record<string, Token> = {
  [VSOL_TOKEN_OBJ.mintAccount.toBase58()]: VSOL_TOKEN_OBJ,
  [VLP_TOKEN_OBJ.mintAccount.toBase58()]: VLP_TOKEN_OBJ,
};

/**
 * Known invoicers, used only as the fallback source of invoices when the RPC
 * does not support `getProgramAccounts` (the primary path, which discovers
 * every invoicer automatically — including ones created after this file was
 * written). Override with a comma-separated `INVOICERS` env list.
 */
const KNOWN_INVOICERS = [
  "Fn5FbRbJzohohUBnwcAYHuQyAz89Q4VBHwsR5hZSGkDa", // SaaS, vSOL
  "AzEQWHYLustmnuKBduSN9pwpGvFnqBNW1rGy79Nddvqi", // community pool, vSOL
  "9HE9R14dazhR1rz6Vamap7zTzkVihqiWVk5nS447PB6F", // community pool, VLP
  "DzWNQFv5FPVwpiSehxDJJ8KMMMp89XEjVswsAmqB5ARF", // SaaS, VLP
];

const invoicerCandidates = (): PublicKey[] =>
  (INVOICERS ?? KNOWN_INVOICERS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new PublicKey(s));

const connection = new Connection(RPC_URL);

const makeInvoicerProgram = (provider: AnchorProvider) =>
  new Program(vaultInvoicerIDL as any, provider);

const makeLiquidUnstakerProgram = (provider: AnchorProvider) =>
  new Program(liquidUnstakerIDL as any, provider);

/**
 * Lists all invoices of this bot's validator across every invoicer that
 * exists (SaaS/pool × vSOL/VLP), primary path a program account scan
 * filtered by the vote account at its known offset; fallback derives the
 * invoice PDAs for the epochs window over `INVOICERS`.
 * Returns them oldest-first so no invoice ages out of reach unpaid.
 */
const getInvoices = async (voteAccount: PublicKey): Promise<Invoice[]> => {
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
    .filter((i) => i.balanceOutstanding > 0 && i.amountVsol > 0)
    .sort((a, b) => a.epoch - b.epoch);
};

/**
 * Decides the payment mint + reserves account of an invoicer from its raw
 * account bytes: 304 B accounts carry their mint at @272, their reserves ATA
 * at @42+6 (anchor's explicit `_padding [u8; 6]` after the PDA bump aligns
 * `vsol_reserves` to @48). A 272 B invoicer predates all of that and is paid
 * in vSOL. Anything else is program drift — stop loudly rather than pay into
 * the wrong token.
 */
const RESERVES_OFFSET = 48;
const MINT_OFFSET = 272;

const resolveInvoicer = async (address: PublicKey): Promise<InvoicerInfo> => {
  const info = await connection.getAccountInfo(address);
  if (!info) throw Error(`Invoicer ${address.toBase58()} not found`);
  const data = info.data;
  let mint: PublicKey;
  if (data.length === 304) {
    const mintBytes = data.subarray(MINT_OFFSET, MINT_OFFSET + 32);
    mint = mintBytes.equals(new Uint8Array(32).fill(0))
      ? new PublicKey(STAKE_POOL_MINT)
      : new PublicKey(mintBytes);
  } else if (data.length === 272) {
    mint = new PublicKey(STAKE_POOL_MINT);
  } else {
    throw Error(
      `Unexpected Invoicer account size ${data.length} for ${address.toBase58()} — ` +
        `this bot understands only the 272 B (pre-mint) and 304 B (mint-aware) layouts. Update saas-payment-bot.`,
    );
  }
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

const getInvoicerInfos = async (invoices: Invoice[]) => {
  const cache = new Map<string, InvoicerInfo>();
  for (const invoice of invoices) {
    const key = invoice.invoicer.toBase58();
    if (!cache.has(key)) {
      cache.set(key, await resolveInvoicer(invoice.invoicer));
    }
  }
  return cache;
};

const getTokenBalance = async (owner: PublicKey, mint: PublicKey) => {
  const accounts = await connection.getTokenAccountsByOwner(owner, { mint });
  return accounts.value.reduce(
    (acc, a) =>
      acc + Number(a.account.data.readBigUInt64LE(64)) / 10 ** 9,
    0,
  );
};

const swapSOLForVSOL = async (
  provider: Provider,
  userPublicKey: PublicKey,
  amount: number,
) => {
  const destinationPoolAccount = await getOrCreateATA({
    provider,
    mint: new PublicKey(STAKE_POOL_MINT),
    owner: userPublicKey,
  });

  const tx = await depositSol(
    connection,
    new PublicKey(STAKE_POOL_ADDRESS),
    userPublicKey,
    amount,
    destinationPoolAccount.address,
  );

  const instructions: TransactionInstruction[] = [
    destinationPoolAccount.instruction,
    ...tx.instructions,
  ].filter((i): i is TransactionInstruction => !!i);

  return { instructions, signers: tx.signers };
};

/**
 * The liquid unstaker's SOL -> VLP route: `deposit_sol` mints VLP straight
 * into the payer's VLP ATA. Mirrors the dapp's buildDepositSolInstructions.
 */
const buildDepositSolInstructions = async (
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
      systemProgram: { pubkey: PublicKey.default, isSigner: false, isWritable: false },
      tokenProgram: { pubkey: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), isSigner: false, isWritable: false },
    })
    .instruction();

  return {
    instructions: [userLpAccount.instruction, depositIx].filter(
      (i): i is TransactionInstruction => !!i,
    ),
  };
};

const getVSOLPrice = async () => {
  const stakePool = await stakePoolInfo(
    connection,
    new PublicKey(STAKE_POOL_ADDRESS),
  );
  return new BigNumber(stakePool?.totalLamports ?? 0)
    .div(new BigNumber(stakePool?.poolTokenSupply ?? 0))
    .toNumber();
};

/**
 * Price of one VLP in SOL, from the unstake pool account:
 * (SOL in the vault + deactivating stake lamports) / circulating VLP.
 * Deliberately a floor — the pool also holds LST inventory not counted here
 * — the funded SOL amount adds a margin on top of it, which only ever buys
 * extra VLP balance usable by later invoices.
 */
const getVLPPriceSol = async () => {
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
  const invoicerInfos = await getInvoicerInfos(invoices);

  const payable = invoices.filter((i) =>
    !!TOKENS[
      invoicerInfos
        .get(i.invoicer.toBase58())!
        .mint.toBase58()
    ],
  );
  for (const invoice of invoices) {
    if (!payable.includes(invoice)) {
      console.log(
        `Skipping epoch ${invoice.epoch} of ${invoice.invoicer.toBase58()}: its invoicer settles in ${invoicerInfos.get(invoice.invoicer.toBase58())!.mint.toBase58()}, a token this bot cannot fund.`,
      );
    }
  }

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
    entry.amount += invoice.amountVsol;
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

  let vSOLPrice: number | null = null;
  let vlpPriceSol: number | null = null;
  try {
    vSOLPrice = await getVSOLPrice();
  } catch (e: any) {
    console.log(`vSOL price unavailable: ${e.message}`);
  }
  try {
    vlpPriceSol = await getVLPPriceSol();
  } catch (e: any) {
    console.log(`VLP price unavailable: ${e.message}`);
  }

  // Plan view: what is due per token, what the wallet holds, and roughly how
  // much SOL a top-up needs (VLP: floor price + 30% margin). Listing only —
  // funding instructions are built during a real run so LIST never signs.
  const plan = [...dueByMint.values()].map(({ mint, amount }) => {
    const dueTokens = Number(amount) / 10 ** 9;
    const balance = balances.get(mint.toBase58()) ?? 0;
    const deficit = Math.max(0, dueTokens - balance);
    const price = mint.equals(VSOL_TOKEN_OBJ.mintAccount)
      ? vSOLPrice
      : mint.equals(VLP_TOKEN_OBJ.mintAccount)
        ? vlpPriceSol
        : null;
    return {
      mint: mint.toBase58(),
      due: dueTokens,
      balance,
      fundSol:
        price && deficit > 0
          ? deficit * price * (mint.equals(VLP_TOKEN_OBJ.mintAccount) ? 1.3 : 1)
          : 0,
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
            Number(i.amountVsol) / 10 ** 9,
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

  if (payer && provider) {
    // Top up payment tokens that are short, as one funding transaction, then
    // re-read balances. A token we cannot fund (price oracle down, deposit
    // caps, no SOL) only costs that token its invoices this run — the other
    // token's invoices still get paid from its balance.
    const fundingIxs: TransactionInstruction[] = [];
    const fundingSigners: Signer[] = [];
    const fundingSol = new Map<string, number>();
    for (const { mint, amount } of dueByMint.values()) {
      const dueTokens = Number(amount) / 10 ** 9;
      const balance = balances.get(mint.toBase58()) ?? 0;
      if (balance >= dueTokens) continue;
      const deficit = dueTokens - balance;
      try {
        if (mint.equals(VSOL_TOKEN_OBJ.mintAccount)) {
          if (!vSOLPrice) throw new Error("vSOL price unavailable");
          const lamports = Math.ceil(deficit * vSOLPrice * 10 ** 9);
          const ixs = await swapSOLForVSOL(provider, payer.publicKey, lamports);
          fundingIxs.push(...ixs.instructions);
          fundingSigners.push(...ixs.signers);
          fundingSol.set(mint.toBase58(), lamports / LAMPORTS_PER_SOL);
        } else if (mint.equals(VLP_TOKEN_OBJ.mintAccount)) {
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
        await sendTransactionWithRetry(
          connection,
          fundingIxs,
          [...fundingSigners],
          payer,
          [],
        );
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
  for (const [i, chunk] of chunks.entries()) {
    console.log(`Paying chunk ${i + 1}/${chunks.length}...`);
    const hash = await sendTransactionWithRetry(
      connection,
      chunk,
      [payer!],
      payer!,
      [],
    );
    console.log(hash);
  }
  console.log(
    `Paid ${payableNow.length} invoice(s): ${payableNow.map((i) => i.epoch).join(", ")}`,
  );
};

const makeInvoicerProgramReadOnly = () =>
  makeInvoicerProgram(
    new AnchorProvider(
      connection,
      { publicKey: PublicKey.default } as any,
      { commitment: "confirmed" },
    ),
  );

const buildPayChunks = async (
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
          .payInvoice(new BN(invoice.amountVsol.toString()))
          .accountsPartial({
            // The parsed invoice carries the invoicer that issued it, so a
            // pool invoice pays into the pool's invoicer and a SaaS invoice
            // into the production one, with no branch here — vSOL invoices
            // pay from the vSOL ATA, VLP invoices from the VLP ATA.
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

payInvoices();
