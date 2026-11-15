#!/usr/bin/env bash
# Builds the EU reference wallet (eudi-app-android-wallet-ui), dev flavor, debug build, with the
# Wallet QA test patch: clones the wallet at a pinned commit, applies wallet/eudi-wallet-dev.patch,
# copies the two Wallet QA trust roots into the wallet's resources and runs Gradle.
#
#   deploy/tls/root.crt                 -> network-logic res/raw/wallet_qa_tls_root.pem
#                                          (HTTPS to https://localhost:8443 and :3443)
#   public/trust/wallet-qa-test-root.der -> resources-logic res/raw/wallet_qa_test_root.der
#                                          (issuer, metadata and reader trust, next to the EU lists)
#
# Output: build/wallet-dev-debug.apk (never committed).
#
# Environment:
#   WALLET_QA_DIR   Wallet QA checkout (default: the repository this script lives in)
#   WORK_DIR        where the wallet is cloned (default: automation/android/.work)
#   WALLET_COMMIT   override the pinned wallet commit
#   SKIP_GRADLE=1   prepare the patched source tree only
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
android_dir="$(cd "$here/.." && pwd)"
wallet_qa_dir="${WALLET_QA_DIR:-$(cd "$android_dir/../.." && pwd)}"
work_dir="${WORK_DIR:-$android_dir/.work}"

wallet_repo=https://github.com/eu-digital-identity-wallet/eudi-app-android-wallet-ui.git
# main on 2026-11-13 (wallet-core 0.32.0). Change together with the patch.
wallet_commit="${WALLET_COMMIT:-428628bc915e6729edb591185baddaf2df26509b}"
patch_file="$android_dir/wallet/eudi-wallet-dev.patch"
src="$work_dir/eudi-app-android-wallet-ui"

mkdir -p "$work_dir"
if [[ ! -d "$src/.git" ]]; then
  git init -q "$src"
  git -C "$src" remote add origin "$wallet_repo"
fi
git -C "$src" fetch -q --depth 1 origin "$wallet_commit"
git -C "$src" checkout -q --force "$wallet_commit"
git -C "$src" clean -q -fdx -e local.properties
echo "Wallet source at $wallet_commit"

git -C "$src" apply --whitespace=nowarn "$patch_file"
echo "Applied $(basename "$patch_file")"

mkdir -p "$src/network-logic/src/main/res/raw" "$src/resources-logic/src/main/res/raw"
install -m 0644 "$wallet_qa_dir/deploy/tls/root.crt" \
  "$src/network-logic/src/main/res/raw/wallet_qa_tls_root.pem"
install -m 0644 "$wallet_qa_dir/public/trust/wallet-qa-test-root.der" \
  "$src/resources-logic/src/main/res/raw/wallet_qa_test_root.der"
echo "Copied the Wallet QA TLS root and test root into the wallet resources"

[[ "${SKIP_GRADLE:-0}" == 1 ]] && exit 0

if [[ ! -f "$src/local.properties" && -n "${ANDROID_HOME:-}" ]]; then
  echo "sdk.dir=$ANDROID_HOME" > "$src/local.properties"
fi

(cd "$src" && ./gradlew --no-daemon --stacktrace :app:assembleDevDebug)

mkdir -p "$android_dir/build"
apk="$(find "$src/app/build/outputs/apk/dev/debug" -name '*.apk' | head -1)"
cp "$apk" "$android_dir/build/wallet-dev-debug.apk"
echo "APK: $android_dir/build/wallet-dev-debug.apk"
