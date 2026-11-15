#!/usr/bin/env bash
# Checks that a running emulator reaches the Wallet QA stack as https://localhost:8443
# and https://localhost:3443 through `adb reverse`, with a certificate that chains to the
# Wallet QA TLS Test Root. Saves a screenshot and logcat to ARTIFACTS_DIR.
#
# Expects exactly one emulator or device on adb and the stack running (stack-up.sh).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
wallet_qa_dir="${WALLET_QA_DIR:-$(cd "$here/../../.." && pwd)}"
artifacts="${ARTIFACTS_DIR:-$here/../artifacts}"
mkdir -p "$artifacts"

adb wait-for-device
echo "Android $(adb shell getprop ro.build.version.release | tr -d '\r')," \
  "API $(adb shell getprop ro.build.version.sdk | tr -d '\r')," \
  "ABI $(adb shell getprop ro.product.cpu.abi | tr -d '\r')"

for port in 8443 3443; do adb reverse "tcp:$port" "tcp:$port"; done
adb reverse --list

device_root=/data/local/tmp/wallet-qa-tls-root.crt
adb push "$wallet_qa_dir/deploy/tls/root.crt" "$device_root" >/dev/null

fail=0
if adb shell 'command -v curl' >/dev/null 2>&1; then
  # Full check: TLS verified against the test root, as the wallet will do it.
  for url in https://localhost:8443/health/ready https://localhost:3443/health; do
    code="$(adb shell "curl -sS -o /dev/null -w '%{http_code}' --cacert $device_root $url" | tr -d '\r' || true)"
    echo "emulator -> $url: HTTP $code"
    [[ "$code" == 200 ]] || fail=1
  done
else
  # Weaker check: the image has no curl, so only test that the ports accept connections.
  echo "No curl in the emulator image; checking TCP reachability only"
  for port in 8443 3443; do
    if adb shell "toybox nc -w 5 localhost $port < /dev/null" >/dev/null 2>&1; then
      echo "emulator -> localhost:$port: open"
    else
      echo "emulator -> localhost:$port: unreachable"; fail=1
    fi
  done
fi

adb exec-out screencap -p > "$artifacts/emulator-home.png"
adb logcat -d > "$artifacts/logcat.txt"

if [[ $fail -ne 0 ]]; then echo "FAIL: emulator cannot reach the stack"; exit 1; fi
echo "PASS: emulator reaches the stack"
