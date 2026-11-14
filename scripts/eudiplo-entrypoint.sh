#!/bin/sh
# Entrypoint of the Wallet QA EUDIPLO image. The tenant config comes from the image, i.e. from
# git. A deployment can mount an overlay at /app/config-overlay with the same layout,
# <tenant>/<path>; every file in it replaces (or adds) the file at that path in the tenant's
# config before EUDIPLO imports it. That is where a deployment puts what git cannot hold:
# key chains for its hostname, access certificates from its registrar, presentation configs
# with registration certificates. See docs/hosting.md. Unknown tenants are ignored.
set -eu
config="${CONFIG_FOLDER:-/app/config/config}"
overlay=/app/config-overlay
if [ -d "$overlay" ]; then
  for tenant_dir in "$overlay"/*/; do
    [ -d "$tenant_dir" ] || continue
    tenant=$(basename "$tenant_dir")
    if [ ! -d "$config/$tenant" ]; then
      echo "[config-overlay] ignoring $tenant: not a tenant of this image"
      continue
    fi
    cp -R "$tenant_dir". "$config/$tenant/"
    (cd "$tenant_dir" && find . -type f | sed "s|^\./|[config-overlay] $tenant/|")
  done
fi
exec docker-entrypoint.sh "$@"
