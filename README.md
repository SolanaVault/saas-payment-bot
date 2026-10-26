# SaaS payment bot

A minimal bot for validators: pays your invoices from The Vault's SaaS +
community-pool invoicers (VLP) using a daily GitHub Actions cron.
The bot only needs a funded wallet and your vote account key.

## Setup

1. Fork this repository, go to Settings -> Secrets -> Actions and add:
   - `RPC_URL`: an RPC that supports `getProgramAccounts` (Helius, Triton, …).
     If yours does not, also set `INVOICERS` (see below).
   - `VOTE_KEY`: your validator vote account.
   - `PRIVATE_KEY`: JSON byte array (e.g. output of `cat my-key.json`) of a
     wallet funded with SOL. It holds VLP automatically.
2. Enable Actions on the fork (the workflow runs daily at 00:00 UTC).

## What it pays

Invoices are discovered on-chain by scanning the `epoch-invoicer` program for
invoice accounts owned by your vote account — this covers **every invoicer
that bills you**, currently the two VLP ones (billing cut over from vSOL to
VLP at epoch 1064; the retired vSOL invoicers are never paid):

| invoicer | settlement token |
| --- | --- |
| `9HE9R14d…` (community pool) | VLP |
| `DzWNQFv5…` (SaaS) | VLP |

The bot reads each invoicer's settlement `mint` from the invoicer account
itself and pays with that token.

### Security: only trusted invoicers are ever paid

`create_invoicer` on this program is **permissionless** — anyone can deploy an
invoicer (settlement token included) and issue invoices
against any vote account for any amount. Discovery above is therefore broad,
but payment is gated: **invoices from invoicers outside the trusted list below
are skipped, not paid**, and a `SECURITY:` line names them.

Trusted invoicers: `9HE9R14d…`, `DzWNQFv5…`
(override the set with `INVOICERS`).

When The Vault adds a new invoicer, add its address to `INVOICERS` — and
verify the address through official channels first (an invoicer's `owner`
field must have signed its creation, so the vault-owned SaaS invoicers carry
the vault multisig there); do not paste an address out of a DM.
`ALLOW_UNTRUSTED_INVOICERS=1` overrides the gate (logs a WARNING) for e.g.
an invoicer rotation you already verified.

## Funding

If your wallet lacks the VLP an invoice settles in, the bot buys it with
SOL inside the run:

- VLP: minted by The Vault's liquid unstaker (`deposit_sol`), the same route
  the dapp's “Pay” button uses. Estimated from the pool's SOL/VLP rate with a
  30% margin — the surplus just stays in your VLP balance for later runs.

The bot pays VLP only; the vSOL funding/deposit machinery (Marinade stake
pool) was removed after the epoch-1064 billing cutover. A top-up failure
(price oracle down, pool deposit caps, no SOL) skips funding for that run;
invoices already covered by your balances still get
paid. Funding transactions are confirmed (polled to `confirmed`/`finalized`)
**before** balances are re-read and before anything is paid — balances are
read at `confirmed`, never off a pre-funding read. A funding tx that stays
unsettled is re-broadcast up to twice (never while the confirmed balance
already covers what it buys), and if it still won't settle, that token's
invoices are deferred to the next run; if the tx lands after the run, the next
run sees the bought balance and pays without re-funding.
Invoices are paid oldest-first (max `MAX_INVOICES_PER_RUN`, default 10,
within `LOOKBACK_EPOCHS`, default 20) so old invoices never age out unpaid.

## Diagnostics

```bash
yarn i
RPC_URL=… VOTE_KEY=… PRIVATE_KEY=… LIST_ONLY=1 yarn run
```

prints the unpaid invoices, resolved settlement mints, balances and planned
top-ups, and builds (never signs or sends) the pay transactions — safe on any
machine, and useful in Actions logs when debugging “why didn't it pay”.

## Config (optional env)

| var | default | meaning |
| --- | --- | --- |
| `LIST_ONLY` | unset | `1`: diagnostics only, never sends. |
| `MAX_INVOICES_PER_RUN` | `10` | cap per day (oldest first). |
| `LOOKBACK_EPOCHS` | `20` | ignore unpaid invoices older than this. |
| `INVOICERS` | built-in list of the two known VLP invoicers | comma-separated **trusted** invoicer addresses: invoices from any other invoicer are never paid, and this set is also the PDA fallback source for scan-less RPCs. Update it when The Vault adds an invoicer — see Security above. |
| `ALLOW_UNTRUSTED_INVOICERS` | unset | `1`: pay invoices from untrusted invoicers (logs WARNING). Only after verifying a new/rotated invoicer out-of-band. |
| `CONFIRM_TIMEOUT_MS` | `90000` | wall-clock bound per broadcast for the confirm poll; on expiry the tx is rebuilt/re-sent (max 2) or deferred. |
| `VERBOSE` | unset | `1`: also print the raw base64 of every built transaction (default output is quiet: `sent <sig>` + outcome only). |
| `FORCE_PDA_FALLBACK` | unset | `1`: skip the program scan and use the PDA/`INVOICERS` path (to test it against your RPC). |

## Testing against a mainnet fork (Surfpool)

`./surfpool-e2e.sh` proves the whole flow — invoice discovery, SOL→VLP
(liquid unstaker) funding, payment, idempotency —
against a **local mainnet fork** served by [Surfpool](https://github.com/surfpool/surfpool)
(tested with surfpool 1.5.0). It never talks to real mainnet with your wallet:
every transaction goes to the fork; accounts are materialized on demand from
the public RPC. No secrets, no funds — the payer is a throwaway keypair funded
by the fork's `requestAirdrop`.

```bash
yarn i                                  # once
./surfpool-e2e.sh                       # starts a fork on :8899, runs the suite, stops it
FORK_PORT=9099 ./surfpool-e2e.sh        # if 8899 is taken (e.g. by a local validator)
```

Steps (each maps to one exit code — `0` all green, `2` setup, `3`–`9` per step):

| step | proves |
| --- | --- |
| A | throwaway payer funded via `requestAirdrop` on the fork |
| B | the validator's real unpaid invoices (incl. the VLP one) are visible & unpaid |
| E1 | `LIST_ONLY=1` (keyless) serializes/sends nothing (fork tx count unchanged) |
| E2 | an **unfunded** wallet degrades: invoices skipped, nothing sent, no retry loop |
| C | full run: the funding the due tokens require lands confirmed and every due invoice is paid |
| D | invoices flip to `outstanding=0`, wallet deltas sane, immediate re-run pays nothing |
| F | keyless `selftest.ts` against the public RPC (skip with `SKIP_SELFTEST=1`) |

Env overrides: `VOTE_KEY`, `FORK_RPC` (attach to an already-running fork; then
nothing is started or killed — but its state is mutated), `DATASOURCE_RPC`,
`SURFPOOL_BIN`, `PAYER` (reuse a keypair), `AIRDROP_LAMPORTS`, plus the bot's
own `INVOICERS` / `LOOKBACK_EPOCHS` / `MAX_INVOICES_PER_RUN`. Logs land in the
printed `/tmp/saas-e2e.*` work dir; the fork is killed at exit. Step B fails
loudly if the vote has no unpaid invoices on the fork (i.e. real state changed)
— that's a stale expectation, not a bot bug.

**Why no delegation setup is needed:** the bot pays with `pay_invoice`, whose
`source_authority` is the owner of your own VLP token accounts — the bot
signs and pays from the wallet in `PRIVATE_KEY` directly. (`pay_invoice` also
accepts a delegate authority — that's the validator-side auto-debit crank —
but the bot never needs it.) A fresh throwaway wallet is therefore enough to
reach the full-success path on the fork.

What the fork proves vs. the real run: on-chain mechanics (layouts, PDAs,
the funding, payment, idempotency, degradation paths) are fully exercised
against real mainnet state. What only the real validator run proves: the fork
copies mainnet balances/rates at materialization time but slot/sysvar drift is
simulated — final confirmation, priority-fee behavior under congestion, and
actual value leaving your wallet are mainnet-only facts.
