/**
 * selftest.ts — throwaway build-and-simulate check. No secrets, no sends.
 *
 *   npx tsx selftest.ts
 *
 * LIST-only-style: env-less (public RPC + a funded System-owned mainnet
 * account as fee-payer/user identity where a PublicKey is needed — a fresh
 * dummy keypair has no lamports and no mainnet faucet, which trips every
 * sim at the fee level; it is kept as fallback), scans the real unpaid
 * invoices of the vote account via the PDA
 * fallback across the trusted invoicers, and:
 *
 *  1. assembles the FULL funding instruction set of the VLP payment path —
 *     SOL -> VLP via the liquid unstaker depositSol —
 *     plus the payInvoice instructions, asserting nothing throws client-side
 *     (bug A: anchor 0.31 'Wrong input type for account "systemProgram"'
 *     when account metas were passed as {pubkey,isSigner,isWritable} objects);
 *  2. simulates the composed transactions as UNSIGNED (zero-sig) v0 messages
 *     with a fresh blockhash (rpc default sigVerify=false). Any failure must
 *     be funding/signature-level (unfunded dummy payer), never account-shape.
 *
 * Nothing is ever signed or sent.
 */
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { SolanaProvider, SignerWallet } from "@saberhq/solana-contrib";

// Must be in place before bot.ts loads (it validates env at import time).
process.env.RPC_URL ??= "https://api.mainnet-beta.solana.com";
process.env.VOTE_KEY ??= "B1w6SZcyvjyp6zEyStcc8u9AxXAh2AbYvNzMmP9rRKE9";
process.env.INVOICERS ??= [
  "9HE9R14dazhR1rz6Vamap7zTzkVihqiWVk5nS447PB6F", // community pool, VLP
  "DzWNQFv5FPVwpiSehxDJJ8KMMMp89XEjVswsAmqB5ARF", // SaaS, VLP
].join(",");
process.env.LIST_ONLY = "1";
// Spec: scan via PDA fallback (works on RPCs without getProgramAccounts).
process.env.FORCE_PDA_FALLBACK ??= "1";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

/** Errs a zero-lamport dummy fee payer is allowed to produce. Anything else
 * (or a client-side throw) means the account wiring itself is broken. */
const FUNDING_LEVEL =
  /InsufficientFundsForFee|InsufficientFunds|InsufficientAccountFunds|AccountNotFound|AttemptToDebitNonce|AddressNotFound|OwnerRequired|insufficient.*lamports|not enough lamports/i;

const accountShapeIssues = (errJson: string, logs: string[]) => {
  const blob = errJson + logs.join("\n");
  return [
    /Wrong input type/i,
    /not enough account keys/i,
    /not enough program ids/i,
    /missing required program for "?(system|token)/i,
    /Missing.{0,30}account/i,
  ].filter((re) => re.test(blob));
};

const main = async () => {
  const bot = await import("./bot");
  const connection = bot.connection;
  let failed = false;
  const step = (ok: boolean, msg: string) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
    if (!ok) failed = true;
  };

  // ---- 1. real unpaid invoices, PDA fallback over trusted invoicers ----
  const vote = new PublicKey(process.env.VOTE_KEY!);
  const invoices: any[] = await bot.getInvoices(vote);
  console.log(
    `Scanned ${invoices.length} unpaid invoice(s) for ${vote.toBase58()}:\n` +
      invoices
        .map((i) => `  epoch ${i.epoch} invoicer ${i.invoicer.toBase58()} outstanding ${Number(i.balanceOutstanding) / 10 ** 9}`)
        .join("\n"),
  );

  const infos: Map<string, any> = await bot.getInvoicerInfos(invoices);
  const mintOf = (i: any) => infos.get(i.invoicer.toBase58())!.mint as PublicKey;
  const payable = invoices.filter((i) =>
    mintOf(i).equals(bot.VLP_TOKEN_OBJ.mintAccount),
  );

  const dueByMint = new Map<string, PublicKey>();
  for (const i of payable) dueByMint.set(mintOf(i).toBase58(), mintOf(i));
  step(payable.length > 0, `payable invoices: ${payable.length} (${[...dueByMint.keys()].join(", ")})`);

  // ---- 2. env-less provider: fee-payer identity where a PublicKey is needed ----
  // A freshly generated dummy keypair has 0 lamports and mainnet has no
  // faucet; simulateTransaction would stop at the missing fee funds before
  // executing anything. So the identity is ANY funded System-owned account (it never
  // signs: builds are local, sims run with sigVerify=false). Only if that
  // probe fails do we fall back to a dummy keypair (shape checks still run;
  // sims just degrade to funding-level errors).
  const candidate = new PublicKey(
    process.env.SELFTEST_PAYER ?? "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  );
  const candidateInfo = await connection.getAccountInfo(candidate);
  const identity =
    candidateInfo &&
    candidateInfo.owner.equals(SystemProgram.programId) &&
    candidateInfo.lamports > 10 ** 9
      ? candidate
      : Keypair.generate().publicKey; // dummy fallback
  console.log(
    `fee-payer identity: ${identity.toBase58()} ` +
      `(${identity.equals(candidate) ? "funded System-owned identity account" : "unfunded dummy keypair"})`,
  );
  const provider = SolanaProvider.init({
    connection,
    // publicKey is all any code path we exercise reads (nothing signs)
    wallet: new SignerWallet({ publicKey: identity } as any),
  });
  const readOnlyProvider = new AnchorProvider(
    connection,
    { publicKey: identity } as any,
    { commitment: "confirmed" },
  );

  const vlpPriceSol = await bot.getVLPPriceSol();
  console.log(`prices: VLP=${vlpPriceSol} SOL/VLP`);

  // ---- 3. fund+pay instruction sets per mint, must assemble ------------
  const compositions: { label: string; instructions: any[] }[] = [];
  for (const mint of dueByMint.values()) {
    const mintInvoices = payable.filter((i) => mintOf(i).equals(mint));
    const dueTokens =
      Number(mintInvoices.reduce((a: bigint, i: any) => a + i.amount, 0n)) /
      10 ** 9;
    const balance = await bot.getTokenBalance(identity, mint);
    const deficit = dueTokens - balance;
    // Same hard rule as the bot: VLP only — a non-VLP mint is a regression,
    // fail loud rather than build a retired payment path.
    if (!mint.equals(bot.VLP_TOKEN_OBJ.mintAccount))
      throw Error(
        `unexpected non-VLP settlement mint ${mint.toBase58()} — the bot pays VLP only`,
      );
    const lamports = Math.ceil(deficit * vlpPriceSol! * 1.3 * 10 ** 9);
    const fund = await bot.buildDepositSolInstructions(
      bot.makeLiquidUnstakerProgram(readOnlyProvider),
      provider,
      identity,
      new BN(lamports),
    );
    const depositIx = fund.instructions.find(
      (ix) => ix.programId.toBase58() === "2rU1oCHtQ7WJUvy15tKtFvxdYNNSc3id7AzUcjeFSddo",
    );
    // IDL order: pool, sol_vault, lp_mint, user, user_lp_account,
    // inventory_summary, clock, system_program, token_program.
    const names = [
      "pool", "sol_vault", "lp_mint", "user", "user_lp_account",
      "inventory_summary", "clock", "system_program", "token_program",
    ];
    const last = depositIx.keys.length - 1;
    step(
      depositIx.keys.length === 9 &&
        depositIx.keys[7].pubkey.equals(SystemProgram.programId) &&
        depositIx.keys[last].pubkey.equals(TOKEN_PROGRAM_ID) &&
        !depositIx.keys[7].isSigner && !depositIx.keys[7].isWritable &&
        !depositIx.keys[last].isSigner && !depositIx.keys[last].isWritable,
      `liquid-unstaker depositSol built with ${depositIx.keys.length} accounts:\n    ` +
        depositIx.keys
          .map((k: any, j: number) => `${names[j]}=${k.pubkey.toBase58()}${k.isSigner ? " S" : ""}${k.isWritable ? " W" : ""}`)
          .join("\n    "),
    );
    const payChunks = await bot.buildPayChunks(
      bot.makeInvoicerProgramReadOnly(),
      mintInvoices,
      infos,
      identity,
    );
    compositions.push({
      label: mint.toBase58(),
      instructions: [...fund.instructions, ...payChunks.flat()],
    });
  }

  // ---- 4. simulate composed UNSIGNED v0 txs (fresh blockhash) ----------
  for (const { label, instructions } of compositions) {
    let sim;
    for (let attempt = 0; ; attempt++) {
      // Fresh blockhash per attempt — same rule as the fixed send path; a
      // 'BlockhashNotFound' here would only be public-RPC load-balancing.
      const { blockhash } = await connection.getLatestBlockhash("finalized");
      const messageV0 = new TransactionMessage({
        payerKey: identity,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();
      const tx = new VersionedTransaction(messageV0); // zero-sig placeholders
      sim = await connection.simulateTransaction(tx, { sigVerify: false });
      if (JSON.stringify(sim.value.err) != '"BlockhashNotFound"' || attempt >= 3)
        break;
      console.log(`SIM ${label}: BlockhashNotFound from RPC, re-simulating with a fresh blockhash (${attempt + 1})...`);
    }
    const errJson = JSON.stringify(sim.value.err ?? null);
    const logs = (sim.value.logs ?? []).slice(-6);
    console.log(
      `\nSIM ${label} (${instructions.length} ixs):\n  err=${errJson}\n  unitsConsumed=${sim.value.unitsConsumed ?? "n/a"}\n  logs:\n    ${logs.join("\n    ")}`,
    );
    const shape = accountShapeIssues(errJson, logs);
    if (sim.value.err && !FUNDING_LEVEL.test(errJson + logs.join("\n"))) {
      shape.push(/unexpected-error/);
    }
    step(
      shape.length === 0,
      `${label}: ${sim.value.err ? "sim error is funding/signature-level only (unfunded dummy payer)" : "no sim error"} — no account-shape issues${shape.length ? " | hits: " + shape.join(",") : ""}`,
    );
  }

  console.log(failed ? "\nSELFTEST FAILED" : "\nSELFTEST PASSED (nothing sent)");
  process.exit(failed ? 1 : 0);
};

main().catch((e) => {
  console.error("SELFTEST CRASHED:", e);
  process.exit(1);
});
