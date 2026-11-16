#!/usr/bin/env bash
# Runs Wallet QA tests in order with one wallet, in one workspace, and prints the report link.
#
#   maestro/run.sh <wallet-folder> <scenario>... [-- <extra maestro args>]
#   maestro/run.sh example I-PID-SDJWT P-PID-ALL-SDJWT -- --device emulator-5554
#
# Reads maestro/.env when present (see .env.example). Tests that need a credential from an
# earlier test ("Run first" on the page) must come after it in the list.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
WALLET="${1:?Usage: $0 <wallet-folder> <scenario>... [-- <maestro args>]}"
shift
SCENARIOS=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do SCENARIOS+=("$1"); shift; done
[ "${1:-}" = "--" ] && shift
[ ${#SCENARIOS[@]} -gt 0 ] || { echo "Name at least one scenario, e.g. P-PID-ALL-SDJWT" >&2; exit 2; }
FLOW="$ROOT/wallets/$WALLET/test.yaml"
[ -f "$FLOW" ] || { echo "No flow at $FLOW" >&2; exit 2; }

ENV_ARGS=()
if [ -f "$ROOT/.env" ]; then
  # KEY=value lines; values may contain spaces and need no quotes. Maestro takes variables only
  # as -e, and empty ones stay unset in the flows.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"; value="${line#*=}"
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
    [ -n "$value" ] || continue
    export "$key=$value"
    ENV_ARGS+=(-e "$key=$value")
  done < "$ROOT/.env"
fi
QA_URL="${QA_URL:-http://127.0.0.1:8787}"
AUTH=()
[ -n "${QA_USER:-}" ] && AUTH=(-u "$QA_USER:${QA_PASSWORD:-}")

# One workspace for the whole list, so the runs and the JUnit report belong together.
WORKSPACE="$(curl -fsS ${AUTH[@]+"${AUTH[@]}"} -H 'Content-Type: application/json' \
  -d "{\"tester\":\"maestro\",\"wallet\":{\"name\":\"${WALLET_NAME:-$WALLET}\",\"version\":\"${WALLET_VERSION:-}\"}}" \
  "$QA_URL/v1/workspaces" | node -e 'process.stdin.on("data",d=>process.stdout.write(JSON.parse(d).id))')"
echo "Workspace: $QA_URL/w/$WORKSPACE"

failed=0
for scenario in "${SCENARIOS[@]}"; do
  echo "== $scenario"
  maestro test ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} -e SCENARIO="$scenario" -e WORKSPACE="$WORKSPACE" \
    -e QA_URL="$QA_URL" "$@" "$FLOW" || failed=$((failed + 1))
done

curl -fsS ${AUTH[@]+"${AUTH[@]}"} "$QA_URL/v1/workspaces/$WORKSPACE/report?format=junit" \
  -o "$ROOT/wallet-qa-report.xml" && echo "JUnit report: $ROOT/wallet-qa-report.xml"
echo "Results: $QA_URL/w/$WORKSPACE ($failed of ${#SCENARIOS[@]} failed)"
[ "$failed" -eq 0 ]
