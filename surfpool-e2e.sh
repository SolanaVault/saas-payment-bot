#!/usr/bin/env bash
#
# surfpool-e2e.sh — end-to-end proof of the payment bot against a LOCAL
# MAINNET FORK (Surfpool). Never touches real mainnet: every wallet/RPC call
# goes to the fork (the only exception is the optional keyless selftest at the
# end, which is read-only, plus Surfpool's own account materialization).
#
#   ./surfpool-e2e.sh
#
# What it proves (one exit code per step):
#   A  fresh throwaway payer funded on the fork via requestAirdrop
#   B  the validator's real unpaid invoices are visible & unpaid (incl. VLP)
#   E1 LIST_ONLY=1 sends nothing (fork transaction count unchanged)
#   E2 unfunded wallet degrades cleanly: no send, no zero-sig retry loop
#   C  full bot run: the funding the due tokens require (SOL->VLP liquid
#      staker deposit_sol) lands CONFIRMED on the fork
#      (top-up tx is polled to confirmed, balances re-read at 'confirmed',
#      only then the pay decision) and every due invoice gets paid. The bot
#      pays with owner-signed pay_invoice from its own ATAs — no delegation
#      setup is needed (see README section).
#   D  post-state: invoices flip to outstanding=0, wallet balances sane, and an
#      immediate re-run has nothing left to pay (idempotency)
#   F  keyless selftest against the public mainnet RPC (skip: SKIP_SELFTEST=1)
#
# Exit codes: 0 all green · 2 setup/prereq · 3 A · 4 B · 5 C · 6 D · 7 E1 ·
#             8 E2 · 9 selftest
#
# Env overrides:
#   VOTE_KEY            vote account to bill for (default: the reference validator)
#   FORK_PORT           fork RPC port (default 8899; WS = port+1)
#   FORK_RPC            attach to an already-running fork at this URL (no start/kill)
#   DATASOURCE_RPC      mainnet RPC the fork materializes from
#   SURFPOOL_BIN        surfpool binary (default: surfpool on PATH)
#   PAYER               payer keyfile (default: fresh temp keypair)
#   AIRDROP_LAMPORTS    requestAirdrop amount for step A (default 1e9 = 1 SOL)
#   INVOICERS LOOKBACK_EPOCHS MAX_INVOICES_PER_RUN   forwarded to the bot + scans
#   SKIP_SELFTEST=1     skip step F
set -u -o pipefail

EXPORT_CODE=0
STEP() { echo; echo "== $* =="; }
fail() { echo "FAIL: $*"; harvest_logs; exit "$EXPORT_CODE"; }

VOTE_KEY="${VOTE_KEY:-B1w6SZcyvjyp6zEyStcc8u9AxXAh2AbYvNzMmP9rRKE9}"
FORK_PORT="${FORK_PORT:-8899}"
DATASOURCE_RPC="${DATASOURCE_RPC:-https://api.mainnet-beta.solana.com}"
SURFPOOL_BIN="${SURFPOOL_BIN:-surfpool}"
AIRDROP_LAMPORTS="${AIRDROP_LAMPORTS:-1000000000}"
export VOTE_KEY LOOKBACK_EPOCHS MAX_INVOICES_PER_RUN INVOICERS

REPO="$(cd "$(dirname "$0")" && pwd)"
WORK="${E2E_WORK:-$(mktemp -d /tmp/saas-e2e.XXXXXX)}"
mkdir -p "$WORK/logs"
PAYER="${PAYER:-$WORK/payer.json}"
PAYER_WAS_NEW=0
[ -f "$PAYER" ] || PAYER_WAS_NEW=1
UNFUNDED_PAYER="$WORK/unfunded-payer.json"
DUE="$WORK/due.txt"
SURF_LOG="$WORK/logs/surfpool.out"
RUN_LOG="$WORK/run.log"
IDEM_LOG="$WORK/repeat.log"
ST_LOG="$WORK/selftest.log"
SURF_PID=""

api() { curl -s --max-time 60 -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }
rpc() { api "$FORK_RPC_URL" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }
HX() { npx tsx "$REPO/e2e-support.ts" "$@"; }
txcount() { HX txcount; }
harvest_logs() {
  echo "--- last surfpool log lines ---"
  if [ -f "$SURF_LOG" ]; then tail -15 "$SURF_LOG"; else echo "(attached to FORK_RPC, no local fork log)"; fi
  echo "(work dir kept: $WORK)"
}
cleanup() {
  if [ -n "$SURF_PID" ]; then
    STEP "cleanup: stopping fork (pid $SURF_PID)"
    kill "$SURF_PID" 2>/dev/null
    sleep 2
    kill -9 "$SURF_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "$REPO"

# ---------- setup ------------------------------------------------------------
STEP "setup: prereqs"
command -v "$SURFPOOL_BIN" >/dev/null || { EXPORT_CODE=2; fail "surfpool not found (SURFPOOL_BIN=$SURFPOOL_BIN) — install from github.com/surfpool/surfpool releases"; }
command -v jq >/dev/null || { EXPORT_CODE=2; fail "jq missing"; }
command -v npx >/dev/null || { EXPORT_CODE=2; fail "npx missing"; }
[ -d node_modules ] || { EXPORT_CODE=2; fail "node_modules missing — run yarn install first"; }

if [ -n "${FORK_RPC:-}" ]; then
  FORK_RPC_URL="$FORK_RPC"
else
  FORK_RPC_URL="http://127.0.0.1:$FORK_PORT"
  if bash -c ">/dev/tcp/127.0.0.1/$FORK_PORT" 2>/dev/null; then
    EXPORT_CODE=2; fail "port $FORK_PORT already in use — set FORK_PORT=<other> or attach a running fork with FORK_RPC=..."
  fi
  STEP "setup: starting fork from $DATASOURCE_RPC ($( "$SURFPOOL_BIN" --version 2>&1 | head -1))"
  "$SURFPOOL_BIN" start --rpc-url "$DATASOURCE_RPC" --port "$FORK_PORT" \
    --ws-port "$((FORK_PORT + 1))" --no-tui --no-studio --airdrop-amount 0 \
    --log-path "$WORK/logs" >"$SURF_LOG" 2>&1 &
  SURF_PID=$!
  READY=0
  for _ in $(seq 1 60); do
    kill -0 "$SURF_PID" 2>/dev/null || { EXPORT_CODE=2; fail "surfpool exited early — see $SURF_LOG"; }
    FORK_SLOT=$(rpc getSlot '[]' | jq -r .result 2>/dev/null)
    if [ -n "$FORK_SLOT" ] && [ "$FORK_SLOT" != "null" ]; then READY=1; break; fi
    sleep 1
  done
  [ "$READY" = 1 ] || { EXPORT_CODE=2; fail "fork RPC did not answer within 60s — see $SURF_LOG"; }
fi
FORK_SLOT=$(rpc getSlot '[]' | jq -r .result)
FORK_EPOCH=$(rpc getEpochInfo '[]' | jq -r '.result.epoch')
DATASOURCE_SLOT=$(api "$DATASOURCE_RPC" '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' | jq -r '.result // "n/a"')
echo "fork RPC $FORK_RPC_URL  slot=$FORK_SLOT epoch=$FORK_EPOCH (datasource slot=$DATASOURCE_SLOT)"
if [ "$DATASOURCE_SLOT" != "n/a" ]; then
  GAP=$((DATASOURCE_SLOT > FORK_SLOT ? DATASOURCE_SLOT - FORK_SLOT : FORK_SLOT - DATASOURCE_SLOT))
  [ "$GAP" -lt 30000 ] || { EXPORT_CODE=2; fail "fork slot $FORK_SLOT far from datasource $DATASOURCE_SLOT"; }
fi

export RPC_URL="$FORK_RPC_URL"

# ---------- A: throwaway payer + airdrop --------------------------------------
STEP "A: throwaway payer + requestAirdrop $AIRDROP_LAMPORTS lamports"
PAYER_PUBKEY=$(HX payer "$PAYER") || { EXPORT_CODE=3; fail "payer create failed"; }
echo "payer $PAYER_PUBKEY"
A_OUT=$(HX airdrop "$PAYER" "$AIRDROP_LAMPORTS") || { EXPORT_CODE=3; fail "airdrop failed: $A_OUT"; }
echo "$A_OUT"
LAMPORTS_NOW=$(echo "$A_OUT" | grep -oE 'lamports=[0-9]+' | cut -d= -f2)
[ "${LAMPORTS_NOW:-0}" -ge "$AIRDROP_LAMPORTS" ] || { EXPORT_CODE=3; fail "airdrop did not land ($LAMPORTS_NOW lamports)"; }
echo "PASS A"

# ---------- B: pre-state on the fork -------------------------------------------
STEP "B: pre-state invoices"
HX dump "$PAYER_PUBKEY"
echo "--- due (oldest first, capped at MAX_INVOICES_PER_RUN):"
HX unpaid "$DUE" || { EXPORT_CODE=4; fail "no unpaid invoices visible on the fork — see note in output"; }
echo "PASS B: $(wc -l < "$DUE") due invoice(s) (file $DUE)"

# ---------- E1: LIST_ONLY sends nothing -----------------------------------------
STEP "E1: LIST_ONLY=1 (keyless) must send nothing"
TC1=$(txcount)
L_OUT=$(LIST_ONLY=1 npx tsx bot.ts 2>&1) && L_EXIT=0 || L_EXIT=$?
TC2=$(txcount)
echo "$L_OUT" | tail -2
[ $L_EXIT -eq 0 ] || { EXPORT_CODE=7; fail "E1: LIST_ONLY run exited $L_EXIT"; }
echo "$L_OUT" | grep -qE 'nothing sent|no unpaid invoices' || { EXPORT_CODE=7; fail "E1: LIST_ONLY summary line missing"; }
echo "$L_OUT" | grep -qE '^(CUs:|[A-Za-z0-9+/]{120,}={0,2}$)' && { EXPORT_CODE=7; fail "E1: send path reached in LIST_ONLY mode"; }
# shellcheck disable=SC2015
[ "$TC1" = "$TC2" ] || { EXPORT_CODE=7; fail "E1: fork transaction count moved $TC1 -> $TC2"; }
echo "PASS E1: tx count unchanged ($TC1)"

# ---------- E2: unfunded wallet --------------------------------------------------
STEP "E2: unfunded wallet must degrade, never send / zero-sig-loop"
UNFUNDED_PUBKEY=$(HX payer "$UNFUNDED_PAYER")
echo "unfunded payer $UNFUNDED_PUBKEY"
TC1=$(txcount)
U_OUT=$(PRIVATE_KEY=$(cat "$UNFUNDED_PAYER") npx tsx bot.ts 2>&1) && U_EXIT=0 || U_EXIT=$?
TC2=$(txcount)
echo "$U_OUT" | grep -E 'Cannot fund|skipping top-ups|Still short|Nothing payable|Retrying|TX failed' || true
[ $U_EXIT -eq 0 ] || { EXPORT_CODE=8; fail "E2: unfunded run exited $U_EXIT (must degrade, not crash)"; }
echo "$U_OUT" | grep -q 'Nothing payable this run.' || { EXPORT_CODE=8; fail "E2: expected 'Nothing payable this run.'"; }
echo "$U_OUT" | grep -q 'Retrying' && { EXPORT_CODE=8; fail "E2: retry loop reached (blockheight/1111 regression)"; }
# shellcheck disable=SC2015
[ "$TC1" = "$TC2" ] || { EXPORT_CODE=8; fail "E2: unfunded wallet caused $((TC2-TC1)) transaction(s)"; }
LAM=$(HX dump "$UNFUNDED_PUBKEY" | grep 'BALANCE SOL' | awk '{print $3}')
[ "$LAM" = "0.000000000" ] || { EXPORT_CODE=8; fail "E2: unfunded wallet SOL changed to $LAM"; }
echo "PASS E2: funding skipped, nothing sent, no retry loop"

# ---------- C: full run -------------------------------------------------------------
STEP "C: full bot run (fund the due tokens via the liquid unstaker, then pay_invoice)"
PRIVATE_KEY=$(cat "$PAYER") npx tsx bot.ts >"$RUN_LOG" 2>&1 && C_EXIT=0 || C_EXIT=$?
grep -E 'Funding|Paying chunk|^Paid |Cannot fund|skipping top-ups|Still short|SECURITY|Retrying|TX failed' "$RUN_LOG" || true
[ $C_EXIT -eq 0 ] || { EXPORT_CODE=5; fail "C: bot exited $C_EXIT — see $RUN_LOG"; }
grep -q '^Paid ' "$RUN_LOG" || { EXPORT_CODE=5; fail "C: no 'Paid' line — see $RUN_LOG"; }
echo "$RUN_LOG" | grep -q 'Retrying' && { EXPORT_CODE=5; fail "C: needed send retries — investigate"; }
if [ $PAYER_WAS_NEW -eq 1 ]; then
  grep -q '^Funding:' "$RUN_LOG" || { EXPORT_CODE=5; fail "C: fresh payer did not fund — funding path broken"; }
  # every settlement token the current invoices are due in must have been bought
  for MINT in $(HX due-mints "$DUE"); do
    grep -q "Funding:.*$MINT" "$RUN_LOG" || { EXPORT_CODE=5; fail "C: no funding planned for due mint $MINT"; }
  done
fi
echo "PASS C (log: $RUN_LOG)"

# ---------- D: post-state + idempotency ----------------------------------------------
STEP "D: post-state"
HX dump "$PAYER_PUBKEY"
HX expect-paid "$DUE" || { EXPORT_CODE=6; fail "D: invoices not fully paid on the fork"; }
PRIVATE_KEY=$(cat "$PAYER") npx tsx bot.ts >"$IDEM_LOG" 2>&1 && R_EXIT=0 || R_EXIT=$?
grep -E 'No invoices to pay|^Paid ' "$IDEM_LOG" || true
{ [ $R_EXIT -eq 0 ] && grep -q 'No invoices to pay' "$IDEM_LOG" && ! grep -q '^Paid ' "$IDEM_LOG"; } || { EXPORT_CODE=6; fail "D: re-run not idempotent — see $IDEM_LOG"; }
echo "PASS D: all due invoices outstanding=0, re-run pays nothing"

# ---------- F: keyless selftest (optional) ------------------------------------------
if [ "${SKIP_SELFTEST:-}" = "1" ]; then
  echo; echo "== F: selftest skipped (SKIP_SELFTEST=1) =="
else
  STEP "F: keyless selftest vs public mainnet RPC (read-only)"
  if env -u RPC_URL -u VOTE_KEY -u PRIVATE_KEY -u LIST_ONLY -u FORCE_PDA_FALLBACK -u INVOICERS \
      npx tsx selftest.ts >"$ST_LOG" 2>&1; then
    grep -E 'SELFTEST PASSED' "$ST_LOG"
    echo "PASS F"
  else
    tail -15 "$ST_LOG"
    EXPORT_CODE=9; fail "F: selftest failed (public mainnet state may have changed, or bot regression) — see $ST_LOG"
  fi
fi

echo
echo "ALL GREEN — fork slotted at $FORK_SLOT (epoch $FORK_EPOCH, surfpool $("$SURFPOOL_BIN" --version | head -1)); logs: $WORK"
