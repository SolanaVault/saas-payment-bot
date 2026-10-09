# SaaS payment bot

A minimal bot for validators: pays your invoices from The Vault's SaaS +
community-pool invoicers (vSOL and VLP) using a daily GitHub Actions cron.
The bot only needs a funded wallet and your vote account key.

## Setup

1. Fork this repository, go to Settings -> Secrets -> Actions and add:
   - `RPC_URL`: an RPC that supports `getProgramAccounts` (Helius, Triton, …).
     If yours does not, also set `INVOICERS` (see below).
   - `VOTE_KEY`: your validator vote account.
   - `PRIVATE_KEY`: JSON byte array (e.g. output of `cat my-key.json`) of a
     wallet funded with SOL. It holds vSOL/VLP automatically.
2. Enable Actions on the fork (the workflow runs daily at 00:00 UTC).

## What it pays

Invoices are discovered on-chain by scanning the `epoch-invoicer` program for
invoice accounts owned by your vote account — this covers **every invoicer
that bills you**, currently four:

| invoicer | settlement token |
| --- | --- |
| `Fn5FbRbJ…` (SaaS) | vSOL |
| `AzEQWHYL…` (community pool) | vSOL |
| `9HE9R14d…` (community pool) | VLP |
| `DzWNQFv5…` (SaaS) | VLP |

The bot reads each invoicer's settlement `mint` from the invoicer account
itself and pays with that token.

### Security: only trusted invoicers are ever paid

`create_invoicer` on this program is **permissionless** — anyone can deploy an
invoicer (settlement token included, even vSOL or VLP) and issue invoices
against any vote account for any amount. Discovery above is therefore broad,
but payment is gated: **invoices from invoicers outside the trusted list below
are skipped, not paid**, and a `SECURITY:` line names them.

Trusted invoicers: `Fn5FbRbJ…`, `AzEQWHYL…`, `9HE9R14d…`, `DzWNQFv5…`
(override the set with `INVOICERS`).

When The Vault adds a new invoicer, add its address to `INVOICERS` — and
verify the address through official channels first (an invoicer's `owner`
field must have signed its creation, so the vault-owned SaaS invoicers carry
the vault multisig there); do not paste an address out of a DM.
`ALLOW_UNTRUSTED_INVOICERS=1` overrides the gate (logs a WARNING) for e.g.
an invoicer rotation you already verified.

## Funding

If your wallet lacks the token an invoice settles in, the bot buys it with
SOL inside the run:

- vSOL: deposited into the Marinade stake pool (`@solana/spl-stake-pool`).
- VLP: minted by The Vault's liquid unstaker (`deposit_sol`), the same route
  the dapp's “Pay” button uses. Estimated from the pool's SOL/VLP rate with a
  30% margin — the surplus just stays in your VLP balance for later runs.

A token whose top-up fails (price oracle down, pool deposit caps, no SOL) is
skipped for that run; invoices already covered by your balances still get
paid. Invoices are paid oldest-first (max `MAX_INVOICES_PER_RUN`, default 10,
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
| `INVOICERS` | built-in list of the four known invoicers | comma-separated **trusted** invoicer addresses: invoices from any other invoicer are never paid, and this set is also the PDA fallback source for scan-less RPCs. Update it when The Vault adds an invoicer — see Security above. |
| `ALLOW_UNTRUSTED_INVOICERS` | unset | `1`: pay invoices from untrusted invoicers (logs WARNING). Only after verifying a new/rotated invoicer out-of-band. |
| `FORCE_PDA_FALLBACK` | unset | `1`: skip the program scan and use the PDA/`INVOICERS` path (to test it against your RPC). |
