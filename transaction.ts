import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  Signer,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const getCUsForTx = async (
  connection: Connection,
  latestBlockhash: Awaited<ReturnType<typeof connection.getLatestBlockhash>>,
  txs: TransactionInstruction[],
  payerKey: PublicKey,
  retryNum = 0,
) => {
  const messageV0 = new TransactionMessage({
    payerKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: txs,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(messageV0);
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.unitsConsumed === 0) {
    if (retryNum >= 10) {
      return 1.4e6;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return getCUsForTx(
      connection,
      latestBlockhash,
      txs,
      payerKey,
      retryNum + 1,
    );
  }
  const CUs = simulation.value.unitsConsumed ?? 1.4e6;
  return CUs;
};

export const createVersionedTransaction = async (
  connection: Connection,
  txs: TransactionInstruction[],
  payerKey: PublicKey,
  addCUs: boolean,
  atas: AddressLookupTableAccount[],
) => {
  const latestBlockhash = await connection.getLatestBlockhash("finalized");
  const CUs = await getCUsForTx(connection, latestBlockhash, txs, payerKey);
  console.log("CUs:", CUs);

  if (addCUs) {
    txs.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: CUs + 100000, // +1000 for safety and the CU limit ix itself
      }),
    );

    const priorityFee = 0.0001 * LAMPORTS_PER_SOL * 1e6;
    txs.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Math.ceil(priorityFee / CUs),
      }),
    );
  }

  const messageV0 = new TransactionMessage({
    payerKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: txs,
  }).compileToV0Message(atas);
  const transaction = new VersionedTransaction(messageV0);
  return { transaction, latestBlockhash };
};

export const sendTransactionWithRetry = async (
  connection: Connection,
  txs: TransactionInstruction[],
  allSigners: Signer[],
  payerKey: Signer,
  atas: AddressLookupTableAccount[],
  retryNum = 0,
): Promise<string | undefined> => {
  const vt = await createVersionedTransaction(
    connection,
    txs,
    payerKey.publicKey,
    retryNum === 0,
    atas,
  );

  // Filter only the required signers
  const signerPubkeys = vt.transaction.message.staticAccountKeys
    .slice(0, vt.transaction.message.header.numRequiredSignatures)
    .map((p) => p.toString());

  const signers = allSigners.filter(
    (s) =>
      s.publicKey.toString() === payerKey.publicKey.toString() ||
      signerPubkeys.includes(s.publicKey.toString()),
  );
  vt.transaction.sign(signers);

  console.log(Buffer.from(vt.transaction.serialize()).toString("base64"));

  try {
    const hash = await Promise.race([
      (async () => {
        const hash = await connection.sendTransaction(vt.transaction);
        await connection.confirmTransaction(
          {
            signature: hash,
            ...vt.latestBlockhash,
          },
          "processed",
        );
        return hash;
      })(),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 120000));
        throw Error("Timeout");
      })(),
    ]);
    return hash;
  } catch (e: any) {
    console.log(e.message);
    const conditions = [
      "Timeout",
      "failed to send transaction: Transaction simulation failed: Blockhash not found",
      "block height exceeded",
    ];
    if (
      conditions.some(
        (condition) => e.message.includes(condition) && retryNum < 5,
      )
    ) {
      console.log("Retrying...", retryNum, "-", e.message);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return sendTransactionWithRetry(
        connection,
        txs,
        allSigners,
        payerKey,
        atas,
        retryNum + 1,
      );
    } else {
      console.log("TX failed");
      console.log(Buffer.from(vt.transaction.serialize()).toString("base64"));
      throw e;
    }
  }
};
