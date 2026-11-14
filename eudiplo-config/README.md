# EUDIPLO test configuration

This directory is the import root, containing one folder per tenant:

- `base/`: the baseline issuer/verifier tenant, used by profile `default`.
- `issuer-dpop-v1/`: a dedicated DPoP-required issuer, used by profile `dpop-v1`.

Each tenant folder contains its own `info.json`, issuance settings, credentials,
key chains and client. Both issuers use the built-in authorization server; the second
requires DPoP. The base tenant also contains the presentation fixtures.
Docker copies this root to `CONFIG_FOLDER`; folder names become tenant IDs.
Wallet QA links profiles to these tenants in `config/eudiplo-backends.json`.

Files follow EUDIPLO’s `assets/config/demo` reference: each uses the corresponding
`https://eudiplo.dev/schemas/v1/<Resource>ConfigFile.schema.json` URL,
`metadata.generation: 1`, and a `spec` containing the configuration. Key chains use
`spec.keySource` with `type: "private-jwk"`. Use an EUDIPLO image that supports these
schema URLs (`EUDIPLO_VERSION=8.1.0` or later; 7.6.0 predates the format).

Test client secrets are included directly in each tenant's `clients/test.json` and
mirrored in `config/eudiplo-backends.json`. Keep both files aligned when changing a client.

## Signing keys and certificates

The key chains in this directory were generated with `pnpm fixtures:generate localhost`:
every access, attestation, status-list and trust-list key is a fresh P-256 key with a
leaf certificate for `localhost`, issued by the "Wallet QA Test Root CA" published in
`public/trust/` (`test-root.pem`, `wallet-qa-test-root.der`, `trust.json`). This is test
material only. Leaf certificates are valid for one year; regenerate when they expire or
when the public hostname changes:

```sh
rm -rf fixtures && pnpm fixtures:generate <host> fixtures eudiplo-config
rsync -a --delete --exclude README.md fixtures/config/ eudiplo-config/
cp -R fixtures/public/. public/trust/ && rm -f public/trust/test-root.srl
```

`fixtures/ca` holds the private root key and is ignored by git. A new root means
wallets that pinned the old one must be updated.

A hosted instance uses this directory as it is, plus its own overlay: at startup
`scripts/eudiplo-entrypoint.sh` copies every file of the deployment's overlay over the same
path here (its key chains, and for example an access certificate from its registrar or
presentation configs with registration certificates). See
[docs/hosting.md](../docs/hosting.md#what-a-deployment-changes).

This root signs credential material only. HTTPS for the stack is rooted in the
committed Wallet QA TLS Test Root in `deploy/tls/` (see the top-level README).

## Scenarios

`qa-loyalty-member` requests only the member ID for the multi-step selective
disclosure case. The run supplies a unique member ID during issuance and checks it
against the verified presentation.

`qa-*` files belong to the Wallet QA catalog. `qa-pid-*` request the QA PID (no
`trusted_authorities`); the older `pid-*` files request a PID from the PID provider test
environment. `qa-reject-access-*` sign with a broken access certificate selected through
`accessKeyChainId`; the key chains are generated (see above). Signature corruption and
HTTP faults are served by Wallet QA's per-run protocol route and use
`qa-loyalty-member` as their valid baseline.

Config import uses `upsert`. If startup reports "Configuration bundle has blocking
issues", inspect the returned import plan's `issues`: schema validation alone does not
check missing references or unresolved placeholders. `pnpm test` checks that each
tenant's references resolve within the tenant.
