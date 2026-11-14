#!/bin/sh
# Installs the Wallet QA TLS Test Root (deploy/tls/root.crt) into an iOS simulator so the
# wallet accepts https://localhost:8443 (Wallet QA) and https://localhost:3443 (EUDIPLO).
# The root is committed and never changes, so this is needed once per simulator.
# Usage: scripts/trust-simulator.sh [simulator-udid-or-"booted"]
set -eu
cd "$(dirname "$0")/.."
device="${1:-booted}"
xcrun simctl keychain "$device" add-root-cert deploy/tls/root.crt
echo "Installed the Wallet QA TLS Test Root into simulator '$device'."
