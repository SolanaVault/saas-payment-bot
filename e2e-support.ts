/**
 * e2e-support.ts — RPC plumbing for surfpool-e2e.sh. Read-only + airdrops.
 * Nothing here signs or sends anything but airdrops; the BOT does the paying.
 *
 *   npx tsx e2e-support.ts payer       <keyfile>            create/load throwaway payer, print pubkey
 *   npx tsx e2e-support.ts airdrop     <keyfile> [lamports] requestAirdrop + confirm, print lamports after
 *   npx tsx e2e-support.ts dump        [pubkey]             invoice JSON lines (+ token/SOL balances if pubkey given)
 *   npx tsx e2e-support.ts unpaid      <outfile>            due invoices oldest-first (cap MAX_INVOICES_PER_RUN), exit 1 if none
 *   npx tsx e2e-support.ts expect-paid <outfile>            exit 1 unless every listed invoice outstanding == 0
 *   npx tsx e2e-support.ts due-mints   <outfile>            settlement mints of the due invoicers (VLP)
 *   npx tsx e2e-support.ts txcount                          print getTransactionCount
 *
 * env: RPC_URL (fork) VOTE_KEY INVOICERS LOOKBACK_EPOCHS MAX_INVOICES_PER_RUN
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";

const PROGRAM = new PublicKey("EpoivtVh9dgWFxE6MYgF3YnobYWtZr2VfCuP7iT3N927");
const VOTE = new PublicKey(process.env.VOTE_KEY!);
const INVOICERS = (
  process.env.INVOICERS ??
  [
    "9HE9R14dazhR1rz6Vamap7zTzkVihqiWVk5nS447PB6F", // community pool, VLP
    "DzWNQFv5FPVwpiSehxDJJ8KMMMp89XEjVswsAmqB5ARF", // SaaS, VLP
  ]
).join(",");
const LOOKBACK = Math.max(1, Number(process.env.LOOKBACK_EPOCHS ?? 20));
const MAX_PER_RUN = Number(process.env.MAX_INVOICES_PER_RUN ?? 10);
const FIRST_INVOICE_EPOCH = 780;
const MINTS: [string, string][] = [
  ["EUWoTx5vQQrxaDFdeK2PLUVbnmRWjw4x6sBbmcxBaHjF", "VLP"],
];

const conn = new Connection(process.env.RPC_URL!);

// Invoice layout (bot.ts): epoch @72, amount @80, outstanding @88 (u64 LE).
const findInvoice = (invoicer: PublicKey, epoch: number) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("invoice"),
      invoicer.toBytes(),
      VOTE.toBytes(),
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(epoch), 0);
        return b;
      })(),
    ],
    PROGRAM,
  )[0];

interface Row {
  invoicer: string;
  epoch: number;
  address: string;
  amount: number;
  outstanding: number;
}

const scanInvoices = async (): Promise<Row[]> => {
  const currentEpoch = (await conn.getEpochInfo()).epoch;
  const minEpoch = Math.max(
    FIRST_INVOICE_EPOCH,
    currentEpoch - LOOKBACK,
  );
  const addresses: PublicKey[] = [];
  const keys: [string, number][] = [];
  for (const invoicer of INVOICERS.split(",").map((s) => s.trim())) {
    for (let e = minEpoch; e <= currentEpoch; e++) {
      addresses.push(findInvoice(new PublicKey(invoicer), e));
      keys.push([invoicer, e]);
    }
  }
  const rows: Row[] = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(batch);
    infos.forEach((info, j) => {
      if (!info) return;
      const d = info.data;
      rows.push({
        invoicer: keys[i + j][0],
        epoch: Number(d.readBigUInt64LE(72)),
        address: batch[j].toBase58(),
        amount: Number(d.readBigUInt64LE(80)) / 1e9,
        outstanding: Number(d.readBigUInt64LE(88)) / 1e9,
      });
    });
  }
  return rows.sort((a, b) => a.epoch - b.epoch);
};

const balanceOf = async (owner: PublicKey, mint: PublicKey) => {
  const accs = await conn.getTokenAccountsByOwner(owner, { mint });
  return accs.value.reduce(
    (a, i) => a + Number(i.account.data.readBigUInt64LE(64)) / 1e9,
    0,
  );
};

const loadPayer = (keyfile: string, create: boolean) => {
  if (fs.existsSync(keyfile)) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(keyfile, "utf8"))),
    );
  }
  if (!create) throw Error(`no keyfile ${keyfile}`);
  const kp = Keypair.generate();
  fs.writeFileSync(keyfile, JSON.stringify([...kp.secretKey]) + "\n");
  return kp;
};

const main = async () => {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case "payer": {
      console.log(loadPayer(args[0], true).publicKey.toBase58());
      break;
    }
    case "airdrop": {
      const kp = loadPayer(args[0], false);
      const amount = Number(args[1] ?? 1_000_000_000);
      const sig = await conn.requestAirdrop(kp.publicKey, amount);
      const { blockhash, lastValidBlockHeight } =
        await conn.getLatestBlockhash("confirmed");
      const st = await conn.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      if (st.value.err)
        throw Error(`airdrop ${sig} failed: ${JSON.stringify(st.value.err)}`);
      console.log(
        `airdrop ${sig} confirmed; lamports=${await conn.getBalance(kp.publicKey)}`,
      );
      break;
    }
    case "dump": {
      for (const r of await scanInvoices()) console.log(JSON.stringify(r));
      if (args[0]) {
        const owner = new PublicKey(args[0]);
        for (const [mint, sym] of MINTS)
          console.log(
            `BALANCE ${sym} ${(await balanceOf(owner, new PublicKey(mint))).toFixed(9)}`,
          );
        console.log(
          `BALANCE SOL ${((await conn.getBalance(owner)) / 1e9).toFixed(9)}`,
        );
      }
      break;
    }
    case "unpaid": {
      const all = await scanInvoices();
      const unpaid = all.filter((r) => r.outstanding > 0 && r.amount > 0);
      const due = unpaid.slice(0, MAX_PER_RUN);
      if (!due.length) {
        console.error(
          `no unpaid invoice for ${VOTE.toBase58()} on this RPC — ` +
            `real mainnet state may have changed (paid by the validator since the fork facts of this harness).`,
        );
        process.exit(1);
      }
      fs.writeFileSync(
        args[0],
        due.map((r) => `${r.invoicer} ${r.epoch} ${r.amount}`).join("\n") + "\n",
      );
      console.log(
        `${due.length} unpaid of ${all.length} in-window (total unpaid ${unpaid.length})`,
      );
      for (const r of unpaid)
        console.log(
          `  epoch ${r.epoch} ${r.invoicer} amount=${r.amount} outstanding=${r.outstanding}`,
        );
      break;
    }
    case "expect-paid": {
      const want = new Map<number, string>(); // epoch -> invoicer
      for (const line of fs
        .readFileSync(args[0], "utf8")
        .split("\n")
        .filter(Boolean)) {
        const [invoicer, epoch] = line.split(" ");
        want.set(Number(epoch), invoicer);
      }
      const now = new Map(
        (await scanInvoices()).map((r) => [`${r.invoicer}:${r.epoch}`, r]),
      );
      let bad = 0;
      for (const [epoch, invoicer] of [...want].sort((a, b) => a[0] - b[0])) {
        const r = now.get(`${invoicer}:${epoch}`);
        const ok = !!r && r.outstanding === 0;
        console.log(
          `${ok ? "PAID  " : "UNPAID"} epoch ${epoch} ${invoicer} outstanding=${r?.outstanding ?? "account-gone"}`,
        );
        if (!ok) bad++;
      }
      process.exit(bad ? 1 : 0);
    }
    case "due-mints": {
      // Mint each due invoicer settles in (the bot's own layout rule: only
      // the 304 B mint-aware account, mint at @272; a pre-mint 272 B account
      // or a zeroed @272 mint is an unexpected legacy vSOL invoicer — fail
      // loud, exactly as the bot does) — so the harness can assert funding
      // for the token actually due, without hard-coding what the current
      // epoch happens to bill.
      const mints = new Set<string>();
      for (const line of fs
        .readFileSync(args[0], "utf8")
        .split("\n")
        .filter(Boolean)) {
        const invoicer = line.split(" ")[0];
        const info = await conn.getAccountInfo(new PublicKey(invoicer));
        if (!info) continue;
        if (info.data.length !== 304 || info.data.subarray(272, 304).equals(Buffer.alloc(32)))
          throw Error(
            `unexpected legacy vSOL invoicer ${invoicer} (${info.data.length} B account / zeroed mint @272) — the bot pays VLP only`,
          );
        const mint = new PublicKey(info.data.subarray(272, 304)).toBase58();
        if (MINTS.some(([m]) => m === mint)) mints.add(mint);
      }
      for (const m of mints) console.log(m);
      break;
    }
    case "txcount": {
      console.log(await conn.getTransactionCount("confirmed"));
      break;
    }
    default:
      console.error(`unknown cmd ${cmd}`);
      process.exit(2);
  }
};

main().catch((e) => {
  console.error(`e2e-support ${process.argv[2]}: ${e.message ?? e}`);
  process.exit(1);
});
