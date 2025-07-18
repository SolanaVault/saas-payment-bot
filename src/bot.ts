import {
  AccountInfo,
  Connection,
  Keypair,
  PublicKey,
  Signer,
  TransactionInstruction,
} from "@solana/web3.js";
import * as dotenv from "dotenv";
import { sendTransactionWithRetry } from "./transaction.js";
import { z } from "zod";
import vaultInvoicerIDL from "../IDL/vaultInvoicer.json";
import BigNumber from "bignumber.js";
import {AnchorProvider, Program} from "@coral-xyz/anchor";
import { BN } from "bn.js";
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
import { CronJob } from "cron";

const FIRST_INVOICE_EPOCH = 780;

dotenv.config();

const { RPC_URL, VOTE_KEY, PRIVATE_KEY, CRON_SCHEDULE } = process.env;

if (!RPC_URL) {
  throw Error("No RPC URL set");
}
if (!VOTE_KEY) {
  throw Error("No VOTE_KEY set");
}
if (!PRIVATE_KEY) {
  throw Error("No PRIVATE_KEY set");
}

/**
 * An invoice for a validator.
 *
 * There is only one invoice per validator per epoch.
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
  // Amount to pay for the validator in vSOL
  amountVSol: z.coerce.bigint(),
});

interface Invoice {
  invoicer: PublicKey;
  voteAccount: PublicKey;
  epoch: number;
  amountVsol: bigint;
  balanceOutstanding: bigint;
}

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
    new PublicKey(vaultInvoicerIDL.address),
  );
  return key;
};

const invoiceParser = {
  programID: new PublicKey(vaultInvoicerIDL.address),
  name: "Invoice",
  parse: (data: Uint8Array): Invoice => {
    const invoicer = new PublicKey(data.subarray(8, 40));
    const voteAccount = new PublicKey(data.subarray(40, 40 + 32));
    const view = new DataView(data.buffer, data.byteOffset + 72, 8 * 3);
    const epoch = Number(view.getBigUint64(0, true));
    const amountVsol = view.getBigUint64(8, true);
    const balanceOutstanding = view.getBigUint64(16, true);

    return { invoicer, voteAccount, epoch, amountVsol, balanceOutstanding };
  },
};

export type ValidatorInvoice = z.infer<typeof zValidatorInvoice>;

const findInvoicerAddress = (baseKey: PublicKey) => {
  const [key] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("invoicer"), baseKey.toBytes()],
    new PublicKey(vaultInvoicerIDL.address),
  );
  return key;
};

const STAKE_POOL_ADDRESS = "Fu9BYC6tWBo1KMKaP3CFoKfRhqv9akmy3DuYwnCyWiyC";
const STAKE_POOL_MINT = "vSoLxydx6akxyMD9XEcPvGYNGq6Nn66oqVb3UkGkei7";
const INVOICER_BASE_KEY: PublicKey = new PublicKey(
  "vocefgUvSTg7q4ZfeTLg2RAgeYN6V7t6rNVNb3dzrh1",
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

/**
 * The Vault's invoicer.
 */
const INVOICER_ADDRESS: PublicKey = findInvoicerAddress(INVOICER_BASE_KEY);

const swapSOLForVSOL = async (
  connection: Connection,
  provider: Provider,
  userPublicKey: PublicKey,
  amount: number,
) => {
  const destinationPoolAccount = await getOrCreateATA({
    provider,
    mint: new PublicKey(STAKE_POOL_MINT),
    owner: userPublicKey,
  });

  console.log(amount);

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

const getInvoices = async (voteAccount: PublicKey) => {
  const connection = new Connection(RPC_URL);
  const epochInfo = await connection.getEpochInfo();
  const currentEpoch = epochInfo.epoch;
  const last5Epcohs = Array.from(new Array(20), (x, i) => currentEpoch - i - 1);

  const invoiceAddresses = last5Epcohs.map((epoch) =>
    findInvoiceAddress(INVOICER_ADDRESS, voteAccount, epoch),
  );
  const invoiceInfos = await connection.getMultipleAccountsInfo(
    invoiceAddresses,
  );
  return invoiceInfos
    .filter((x): x is AccountInfo<Buffer> => !!x)
    .map((info) => invoiceParser.parse(info?.data))
    .filter(
      (info) =>
        info.balanceOutstanding > 0 && info.epoch >= FIRST_INVOICE_EPOCH,
    )
    .slice(0, 6);
};

const makeEpochInvoicerProgram = (provider: AnchorProvider) =>
  new Program(vaultInvoicerIDL, provider);

const setupPayInvoiceTx = async (signer: Keypair, invoices: Invoice[]) => {
  const connection = new Connection(RPC_URL);
  const allIXs: TransactionInstruction[] = [];
  const allSigners: Signer[] = [];

  const provider = SolanaProvider.init({
    connection,
    wallet: new SignerWallet(signer),
  });

  const stakePool = await stakePoolInfo(
    connection,
    new PublicKey(STAKE_POOL_ADDRESS),
  );

  const vSOLPrice = new BigNumber(stakePool?.totalLamports ?? 0)
    .div(new BigNumber(stakePool?.poolTokenSupply ?? 0))
    .toNumber();

  const ixs = await swapSOLForVSOL(
    connection,
    provider,
    signer.publicKey,
    Math.ceil(
      Number(invoices.reduce((acc, invoice) => acc + invoice.amountVsol, 0n)) *
        vSOLPrice,
    ),
  );
  allIXs.push(...ixs.instructions);
  allSigners.push(...ixs.signers);

  const program = makeEpochInvoicerProgram(
    new AnchorProvider(connection, new SignerWallet(signer)),
  );
  const payInvoiceIXs = await Promise.all(
    invoices.map(async (invoice) =>
      program.methods
        .payInvoice(new BN(invoice.amountVsol.toString()))
        .accountsPartial({
          invoicer: INVOICER_ADDRESS,
          invoice: findInvoiceAddress(
            INVOICER_ADDRESS,
            invoice.voteAccount,
            invoice.epoch,
          ),
          source: getATAAddressSync({
            mint: VSOL_TOKEN_OBJ.mintAccount,
            owner: signer.publicKey,
          }),
        })
        .instruction(),
    ),
  );
  allIXs.push(...payInvoiceIXs);
  return { instructions: allIXs, signers: allSigners };
};

const payInvoices = async () => {
  const connection = new Connection(RPC_URL);
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(PRIVATE_KEY)));

  // Get invoices that need to be paid
  const invoices = await getInvoices(new PublicKey(VOTE_KEY));
  console.log(invoices);
  if (invoices.length === 0) {
    console.log("No invoices to pay");
    return
  }
  const tx = await setupPayInvoiceTx(payer, invoices);
  const hash = await sendTransactionWithRetry(
    connection,
    tx.instructions,
    [...tx.signers, payer],
    payer,
    [],
  );

  console.log(hash);
};

if (CRON_SCHEDULE) {
  console.log("Scheduling cron job to run at", CRON_SCHEDULE);
  const cronJob = CronJob.from({
    cronTime: CRON_SCHEDULE,
    onTick: payInvoices,
    runOnInit: true,
    start: true
  })
} else {
  console.log("No cron schedule provided");
  payInvoices().catch(console.error);
}
