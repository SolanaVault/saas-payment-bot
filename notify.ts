/**
 * Discord webhook notifications for the SaaS payment bot.
 *
 * - Uses native `fetch` (Node >= 18 has it built in; the workflow uses Node 22).
 * - All errors are swallowed and logged as warnings; a webhook failure must
 *   never crash the bot or affect payment behavior.
 * - If the webhook URL is not provided, all helpers become no-ops.
 */

const VALIDATOR_NAME = "Moonlet";

const COLORS = {
  success: 0x57f287, // Discord green
  failure: 0xed4245, // Discord red
  warning: 0xfaa61a, // Discord orange
};

const WEBHOOK_TIMEOUT_MS = 10_000;
const ERROR_MAX_LEN = 1000;

const SOLSCAN_TX = (sig: string) => `https://solscan.io/tx/${sig}`;

const shortSig = (sig: string): string =>
  sig.length > 16 ? `${sig.slice(0, 8)}…${sig.slice(-6)}` : sig;

const safeForCodeBlock = (text: string): string =>
  text.replace(/```/g, "ʼʼʼ");

interface DiscordEmbed {
  title: string;
  url?: string;
  description?: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp: string;
}

const post = async (
  webhookUrl: string,
  body: { embeds: DiscordEmbed[] },
): Promise<void> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `Discord webhook responded with status ${res.status} ${res.statusText}`,
      );
    }
  } catch (e: any) {
    console.warn("Discord webhook failed:", e?.message ?? e);
  } finally {
    clearTimeout(timeout);
  }
};

export interface SuccessNotification {
  invoiceCount: number;
  /** Total amount paid, in vSOL lamports (9 decimals). */
  totalVsolLamports: bigint;
  epochs: number[];
  txHash: string | undefined;
}

export const notifySuccess = async (
  webhookUrl: string | undefined,
  data: SuccessNotification,
): Promise<void> => {
  if (!webhookUrl) return;

  const totalVsol = (Number(data.totalVsolLamports) / 1e9).toFixed(9);
  const txDisplay = data.txHash
    ? `[${shortSig(data.txHash)}](${SOLSCAN_TX(data.txHash)})`
    : "unknown";
  const epochsDisplay =
    data.epochs.length > 0
      ? [...data.epochs].sort((a, b) => a - b).join(", ")
      : "—";

  await post(webhookUrl, {
    embeds: [
      {
        title: "🎉 [The Vault] Invoices Paid Successfully",
        description: `✅ Successfully paid ${data.invoiceCount} invoice(s) for validator \`${VALIDATOR_NAME}\``,
        color: COLORS.success,
        fields: [
          { name: "Total Amount", value: `${totalVsol} vSOL` },
          { name: "Transaction", value: txDisplay },
          { name: "Epochs Paid", value: epochsDisplay },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  });
};

export type RankAlertNotification = {
  threshold: number;
} & (
  | {
      found: true;
      rank: number;
      totalLeaders: number;
      directedSol: number;
    }
  | {
      found: false;
      totalLeaders: number;
    }
);

export const notifyRankAlert = async (
  webhookUrl: string | undefined,
  data: RankAlertNotification,
): Promise<void> => {
  if (!webhookUrl) return;

  const description = data.found
    ? `⚠️ Validator \`${VALIDATOR_NAME}\` dropped below rank #${data.threshold} on the Directed Stake Leaders board`
    : `⚠️ Validator \`${VALIDATOR_NAME}\` was not found on the Directed Stake Leaders board`;

  const fields: { name: string; value: string; inline?: boolean }[] = [
    {
      name: "Rank",
      value: data.found
        ? `#${data.rank} of ${data.totalLeaders}`
        : `not found (of ${data.totalLeaders} leaders)`,
      inline: true,
    },
    { name: "Threshold", value: `#${data.threshold}`, inline: true },
  ];
  if (data.found) {
    fields.push({
      name: "Directed Stake",
      value: `${data.directedSol.toFixed(2)} SOL`,
      inline: true,
    });
  }

  await post(webhookUrl, {
    embeds: [
      {
        title: "⚠️ [The Vault] Directed Stake Rank Alert",
        url: "https://thevault.finance/validators",
        description,
        color: COLORS.warning,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  });
};

export interface FailureNotification {
  error: string;
}

export const notifyFailure = async (
  webhookUrl: string | undefined,
  data: FailureNotification,
): Promise<void> => {
  if (!webhookUrl) return;

  const raw = data.error ?? "Unknown error";
  const truncated =
    raw.length > ERROR_MAX_LEN ? `${raw.slice(0, ERROR_MAX_LEN)}…` : raw;
  const safe = safeForCodeBlock(truncated);

  await post(webhookUrl, {
    embeds: [
      {
        title: "🚨 [The Vault] Invoice Payment Failed",
        description: `❌ Failed to pay invoices for validator \`${VALIDATOR_NAME}\``,
        color: COLORS.failure,
        fields: [{ name: "Error", value: "```\n" + safe + "\n```" }],
        timestamp: new Date().toISOString(),
      },
    ],
  });
};
