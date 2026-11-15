#!/usr/bin/env bash
# Runs the Appium wallet tests against a running emulator and a running Wallet QA stack.
#
#   1. installs the wallet APK (WALLET_APK, default build/wallet-dev-debug.apk) unless
#      SKIP_INSTALL=1, e.g. when starting from an emulator snapshot that already has it;
#   2. maps https://localhost:8443 and :3443 into the emulator with adb reverse;
#   3. starts Appium (UiAutomator2) on 127.0.0.1:4723;
#   4. runs tests/01-onboarding, 02-issue-pid-sdjwt and 03-present-pid-one-sdjwt in order;
#   5. saves the Appium log, logcat and per-test evidence (screenshots, UI hierarchy,
#      evidence.json) to ARTIFACTS_DIR (default: artifacts/).
#
# Expects exactly one device on adb (or ANDROID_SERIAL) and `pnpm install` in this directory.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
android_dir="$(cd "$here/.." && pwd)"
export ARTIFACTS_DIR="${ARTIFACTS_DIR:-$android_dir/artifacts}"
apk="${WALLET_APK:-$android_dir/build/wallet-dev-debug.apk}"
app_id="${WALLET_APP_ID:-eu.europa.ec.euidi.dev}"
mkdir -p "$ARTIFACTS_DIR"
cd "$android_dir"

adb wait-for-device
if [[ "${SKIP_INSTALL:-0}" != 1 ]]; then
  echo "Installing $apk"
  adb install -r -g "$apk"
fi
adb shell pm list packages "$app_id" | grep -q "package:$app_id" || { echo "Wallet $app_id is not installed"; exit 1; }

for port in 8443 3443; do adb reverse "tcp:$port" "tcp:$port"; done
adb logcat -c || true

pnpm run appium > "$ARTIFACTS_DIR/appium.log" 2>&1 &
appium_pid=$!
cleanup() {
  adb logcat -d > "$ARTIFACTS_DIR/logcat.txt" 2>/dev/null || true
  kill "$appium_pid" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:4723/status >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:4723/status >/dev/null || { echo "Appium did not start"; cat "$ARTIFACTS_DIR/appium.log"; exit 1; }

pnpm test 2>&1 | tee "$ARTIFACTS_DIR/test-output.txt"
exit "${PIPESTATUS[0]}"
