# Findings: automated Android wallet testing (spike)

Spike goal: run Wallet QA tests end to end with Appium driving the EU reference wallet
(`eudi-app-android-wallet-ui`, dev flavor) in an Android emulator, with no human involved.
State: November 2026, wallet commit `428628bc` (Wallet Core 0.32.0, OpenID4VCI library 0.16.0),
EUDIPLO 9.1.0.

## Result

| Test | Outcome | Why |
| --- | --- | --- |
| Onboarding (not a Wallet QA test) | passes | Welcome → PIN → confirm PIN → home, fully automated |
| `I-PID-SDJWT` | **fails** (verdict `failed`) | EUDIPLO's protocol check passes and the PID is stored, but the blocking question `card-shown` is answered **no**: the wallet never shows a credential's card image (see [W8](#w8-no-card-image)) |
| `P-PID-ONE-SDJWT` | passes (verdict `passed`) | protocol, selective disclosure (only `given_name` = `ERIKA`) and `verifier-shown` all pass |

So the automation works end to end, and its one failure is a real difference between the wallet
and what Wallet QA asks, which a maintainer needs to decide (see [Decisions](#decisions-for-the-maintainer)).
Every checklist answer is derived from the screen; the evidence (`artifacts/<test>/evidence.json`
plus screenshot and UI hierarchy per answer) shows what was checked and found.

A full run (fresh install, onboarding, issuance, presentation) takes about 35 s of test time locally;
in CI the job is dominated by the emulator boot and, when the patch changed, the wallet build.

## What it took on the wallet side

The patch (`wallet/eudi-wallet-dev.patch`) adds trust anchors and configuration; no check is
switched off.

1. **HTTPS to localhost.** The network security config trusts the system CAs only (no user CAs,
   no debug overrides), so installing the Wallet QA TLS root as a user CA, as
   `docs/tester-guide.md` suggests for Android, does not work for this wallet. The patch adds
   `deploy/tls/root.crt` as a trust anchor for `localhost` only.
2. **Configured issuers only.** The wallet accepts a credential offer only from issuers in its
   config. An offer passed by reference must come from the origin of a configured issuer
   (`OfferIssuerHelper`). The patch adds `https://localhost:3443/issuers/base` and
   `/issuers/issuer-dpop-v1`.
3. **Trust comes from remote EU lists.** There is no local reader trust store: the dev flavor
   downloads lists of trusted entities (LoTE) from `trustedlist.serviceproviders.eudiw.dev` and
   enforces issuer trust for PIDs and reader authentication ("enforce if present"). Wallet Core's
   static `trustedCertificates(...)` would replace those lists, and its ETSI trust source is
   internal. The patch therefore rebuilds the same pipeline in the dev flavor (`WalletQaTrust`,
   about 150 lines copied from Wallet Core's `EtsiTrustProvider` and `LoteJwtVerifier`) and
   checks the Wallet QA test root first. Logcat shows which source trusted a chain
   (`WalletQaTrust`). This copy must be kept in step with Wallet Core.
4. **Client authentication.** The EU issuers use attestation-based client authentication with
   the dev wallet provider. EUDIPLO's `base` tenant advertises
   `token_endpoint_auth_methods_supported: ["none"]`, so the Wallet QA issuers use
   `ClientAuthenticationType.None`.
5. **Proof profile.** Wallet Core 0.32.0 defaults to `IssuanceProofProfile.Etsi`, which accepts
   only attestation-backed proofs (an `attestation` proof or a JWT proof with a key attestation)
   and has no fallback. Wallet QA's issuers do not require key attestations, so the Wallet QA
   issuers use `IssuanceProofProfile.Standard` (plain JWT proof first). Consequence: these tests
   do not cover key attestation.
6. **Diagnostics.** The wallet shows "Oups! Something went wrong" and logs nothing when an offer
   or issuance fails. The patch logs the cause (`WalletQa` tag); without it, this spike would
   have been guesswork.

## Wallet behaviours that needed workarounds (worth reporting upstream)

### W1: Signed issuer metadata and the Accept header
The dev flavor calls `requireSignedMetadata()`. The OpenID4VCI library asks for
`Accept: application/jwt`, but the app's Ktor client (ContentNegotiation) adds `application/json`
to every request, so the request goes out as `Accept: application/jwt; application/json`.
EUDIPLO 9.1 returns the signed JWT only when Accept is exactly `application/jwt`, so the wallet
gets JSON and fails with `MissingSignedMetadata` ("Issuance blocked: the provider could not be
verified"). Both sides can improve: the wallet should not ask for JSON when it requires JWT,
and EUDIPLO could prefer JWT when the client lists it.
**Workaround (Wallet QA, approved):** Caddy forwards `Accept: application/jwt` for metadata requests
that include it (`deploy/Caddyfile`, `deploy/Caddyfile.hosted`). The Traefik setup
(`docker-compose.traefik.yml`) has no such rule yet.

### W2: `attestation` proof type without `key_attestations_required`
EUDIPLO lists the proof types `jwt` and `attestation` by default and adds
`key_attestations_required` only when key attestations are configured. That is spec-conformant:
OpenID4VCI 1.0 §12.2.4 makes `key_attestations_required` OPTIONAL and says it "MUST NOT be present"
when the issuer requires no key attestation. The wallet's OpenID4VCI library 0.16.0 (the latest
release) rejects such metadata as a whole (`attestation proof must contain
'key_attestations_required'`), so no credential of the tenant can be issued.
**Workaround (Wallet QA, approved):** every credential config sets
`config.proofTypesSupported: ["jwt"]`. Effect for every wallet: Wallet QA accepts plain JWT
proofs only, and wallets limited to the ETSI profile (attestation-backed proofs) cannot get
credentials from Wallet QA. This should be reported to `eudi-lib-jvm-openid4vci-kt` and reverted
once fixed.

### W3–W7: Configuration findings (handled in the patch)
- W3: user CAs are ignored (network security config), see 1 above.
- W4: offers only from configured issuers, see 2.
- W5: no way to add trust anchors next to the LoTE lists without copying Wallet Core internals, see 3.
- W6: the dev flavor's client authentication and proof profile assume the EU issuers, see 4 and 5.
- W7: PIN policy: the wallet refuses repeated digits, sequences and common PINs (`123456` is
  rejected). The tests use `258036` (`WALLET_PIN`).

### W8: No card image
The wallet shows a document with its display name and the **issuer's** logo
(`content-desc="Issuer logo"`), in the list, the details and the success screen. It never renders a
credential's `background_image` or credential logo; the source has no code for them. Wallet QA's
blocking question `card-shown` asks for "its name and card image", so the strict, UI-derived answer
is **no** and `I-PID-SDJWT` fails. Whether the issuer logo should count is a question for the
maintainer, not something the test should decide quietly.

### W9: "Issuer verification not performed"
The stored QA PID is labelled "Issuer verification not performed". Its `vct` is
`urn:eudi:pid:de:1`, which the dev flavor does not classify as a PID, so the PID trust policy
(ENFORCE) does not apply and the default policy (INFORM) records no verification. The metadata
signature is verified (`WalletQaTrust` logs it). Worth checking whether the QA PID should use the
`vct` the wallet expects.

## Wallet QA findings

- **Metadata signed with the untrusted access certificate (fixed).** EUDIPLO (8.1 and 9.1) signs
  a tenant's issuer metadata with whichever access key chain it finds first; in `base` that was
  `access-untrusted`. Fixed by moving it to its own tenant `access-untrusted` (with a one-line
  change in `src/testing/catalog.ts`, approved). **Existing instances:** config import is
  upsert, so delete the `access-untrusted` key chain and `qa-reject-access-untrusted` from `base`
  after deploying. EUDIPLO could let an issuance config name its metadata signing key.
- **EUDIPLO 9.1.0.** Upgraded (approved): new image path `ghcr.io/eudiplo/eudiplo`, config files
  rewritten with `eudiplo config upgrade` (schema URLs only). Texts that state EUDIPLO 8.1
  behaviour (catalog skip reasons, README, docs) were not re-verified against 9.1.
- **Run store lock blocks a restarted container.** `FileRunStore` keeps the owner's PID in
  `runs.json.lock` and checks whether it is alive. In a container the server is usually PID 1,
  so after an unclean stop (e.g. `docker compose up --force-recreate`) the new process sees "its
  own" PID and refuses to start ("Local run store is already in use"). Remove the lock from the
  `qa-data` volume to recover.
- **EUDIPLO data is not persistent locally.** `docker-compose.yml` has no volume for EUDIPLO's
  database (the hosted files mount `eudiplo-db:/app/data`). After recreating the container,
  credentials issued before fail presentations (status list 404). The tests therefore issue and
  present against the same stack, and an emulator snapshot with a PID is only useful for the
  stack that issued it.
- **PID claims without display names.** Seven top-level claims of the QA PID (`address`,
  `age_birth_year`, `age_equal_or_over`, `age_in_years`, `issuing_authority`, `place_of_birth`,
  `source_document_type`) have no `display` in `pid.json`, so wallets can only show raw names and
  `claims-shown` is "no" for every wallet. Adding display names is a fixture fix.

## Tooling notes

- Appium 3.9.0 + UiAutomator2 driver 8.7.3 + WebdriverIO 9.32.0. Appium 4.0.0 was published on the
  day of the spike and needs Node ≥ 24.15; WebdriverIO 9.33+/10 need Node ≥ 22.23 or ≥ 24.22. The
  chosen set runs on Node 22.19 (the repo minimum). pnpm 11's minimum release age is kept (no
  exclusions); Appium's extension autoinstall and WebdriverIO's desktop driver downloads are
  blocked in `pnpm-workspace.yaml`.
- The wallet keeps indeterminate spinners on screen; UiAutomator waits for an idle UI by default
  and then blocks. The session sets `waitForIdleTimeout` to 0.
- Compose test tags appear as `eu.europa.ec.euidi.dev:id/<tag>`; the onboarding and document
  screens have few tags, so those steps match English texts.
- CI runs on `ubuntu-24.04` with KVM (API 34 `google_apis` x86_64 emulator). macOS runners cannot
  run the Android emulator. The wallet APK is cached on the patch, the build script and the two
  roots; a cold wallet build takes about 15 to 20 minutes.

## Decisions for the maintainer

1. `card-shown` vs. a wallet that shows no card images (W8): change the question (e.g. "name and
   an image"), accept the failure as a finding, or mark the question non-blocking.
2. Keep W1/W2 workarounds in the shared Wallet QA config, or move them to a tenant used only by
   wallets that need them (needs a backend profile per test, i.e. a catalog change).
3. Fix the fixture gaps (PID display names, PID `vct`) and the run store lock.
4. Report W1 and W2 upstream (wallet / OpenID4VCI library, EUDIPLO content negotiation).
