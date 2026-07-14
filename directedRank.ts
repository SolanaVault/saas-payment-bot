/**
 * Directed Stake Leaders rank check for The Vault.
 *
 * The Vault frontend (https://thevault.finance/validators) doesn't use a
 * private API — it fetches public stakebot data from GitHub:
 *   1. bot-stats-latest.txt  -> path of the latest epoch stats JSON
 *      (e.g. "1001/bot-stats-367690.json")
 *   2. that JSON contains validatorTargets[].targetStake.directed
 * The "Directed" rank is the position when sorting validators with
 * directed stake > 0 by targetStake.directed (descending).
 */

const BASE_URL =
  "https://raw.githubusercontent.com/SolanaVault/stakebot-data/refs/heads/main";

const FETCH_TIMEOUT_MS = 10_000;

interface ValidatorTarget {
  votePubkey: string;
  targetStake?: {
    directed?: string;
  };
}

export type DirectedRankResult =
  | {
      found: true;
      /** 1-based rank among validators with directed stake > 0. */
      rank: number;
      totalLeaders: number;
      /** Directed stake in SOL. */
      directedSol: number;
      sourceFile: string;
    }
  | {
      found: false;
      totalLeaders: number;
      sourceFile: string;
    };

const fetchWithTimeout = async (url: string): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`GET ${url} responded with ${res.status} ${res.statusText}`);
    }
    return res;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Resolves the latest epoch stats file and computes the validator's rank
 * on The Vault's "Directed Stake Leaders" board.
 *
 * Throws on network/parse errors — callers should treat those as non-fatal.
 */
export const getDirectedStakeRank = async (
  votePubkey: string,
): Promise<DirectedRankResult> => {
  // 1. Resolve the latest epoch stats file
  const latestPath = (
    await (await fetchWithTimeout(`${BASE_URL}/bot-stats-latest.txt`)).text()
  ).trim();
  if (!latestPath) {
    throw new Error("Could not resolve latest stakebot stats file");
  }

  // 2. Fetch stats JSON and compute the directed-stake leaderboard
  const stats = (await (
    await fetchWithTimeout(`${BASE_URL}/${latestPath}`)
  ).json()) as { validatorTargets?: ValidatorTarget[] };

  const leaders = (stats.validatorTargets ?? [])
    .map((v) => ({
      votePubkey: v.votePubkey,
      directed: Number(v.targetStake?.directed ?? 0),
    }))
    .filter((v) => v.directed > 0)
    .sort((a, b) => b.directed - a.directed);

  const index = leaders.findIndex((v) => v.votePubkey === votePubkey);
  if (index === -1) {
    return { found: false, totalLeaders: leaders.length, sourceFile: latestPath };
  }

  return {
    found: true,
    rank: index + 1,
    totalLeaders: leaders.length,
    directedSol: leaders[index].directed / 1e9,
    sourceFile: latestPath,
  };
};
