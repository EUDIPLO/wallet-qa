#!/usr/bin/env bash
# Starts the Wallet QA stack (EUDIPLO, Wallet QA, Caddy) and waits until it is healthy.
#
# Creates .env from .env.example with fresh random EUDIPLO secrets if none exists. The
# secrets only protect this throwaway stack, so CI generates new ones on every run.
#
# WALLET_QA_DIR points at the Wallet QA checkout (default: the repository this script lives in).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
wallet_qa_dir="${WALLET_QA_DIR:-$(cd "$here/../../.." && pwd)}"
cd "$wallet_qa_dir"

if [[ ! -f .env ]]; then
  echo "Creating .env with random EUDIPLO secrets"
  sed -e "s/^EUDIPLO_MASTER_SECRET=.*/EUDIPLO_MASTER_SECRET=$(openssl rand -hex 32)/" \
      -e "s/^EUDIPLO_ADMIN_CLIENT_SECRET=.*/EUDIPLO_ADMIN_CLIENT_SECRET=$(openssl rand -hex 32)/" \
      .env.example > .env
fi

docker compose -p wallet-qa up --build -d --wait

# Both wallet-facing origins must answer over HTTPS with the committed TLS test root.
for url in https://localhost:8443/health/ready https://localhost:3443/health; do
  curl -fsS --cacert deploy/tls/root.crt -o /dev/null "$url"
  echo "OK $url"
done
