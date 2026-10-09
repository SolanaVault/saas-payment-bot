// Vendored from SolanaVault/directed-stake @9ef230b (packages/zod-solana/src/zPublicKey.ts).
// Never published to npm — source is inlined here instead of depending on @thevault/zod-solana.
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

/**
 * Public key parser.
 */
export const zPublicKey = z.union([
  z.instanceof(PublicKey),
  z.string().transform((v) => new PublicKey(v)),
]);
