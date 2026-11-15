# Android wallet automation

Runs Wallet QA tests end to end with no human: Appium (UiAutomator2, WebdriverIO) drives the EU
reference wallet ([eudi-app-android-wallet-ui](https://github.com/eu-digital-identity-wallet/eudi-app-android-wallet-ui),
dev flavor) in an Android emulator, and Wallet QA gives the verdict from EUDIPLO's evidence plus
checklist answers that the tests derive from what they saw on screen.

Covered tests: `I-PID-SDJWT` (issue the QA PID) and `P-PID-ONE-SDJWT` (present `given_name` from
it), after a one-time wallet onboarding with the test PIN `258036` (`WALLET_PIN`). Findings, workarounds and open points:
[FINDINGS.md](FINDINGS.md).

Everything lives in this directory with its own `package.json` and pnpm workspace root, so it can
move to another repository. The only links to Wallet QA are `lib/wallet-qa.ts` (imports
`src/client.ts`) and the two trust roots `scripts/build-wallet.sh` copies from it.

## Layout

| Path | What it is |
| --- | --- |
| `wallet/eudi-wallet-dev.patch` | Changes to the wallet at the pinned commit (see below) |
| `scripts/build-wallet.sh` | Clones the wallet at the pinned commit, applies the patch, copies the trust roots, builds `build/wallet-dev-debug.apk` |
| `scripts/stack-up.sh` | Starts the Wallet QA stack (creates `.env` with random secrets if missing) |
| `scripts/emulator-check.sh` | `adb reverse` for ports 8443/3443 and a reachability check from the emulator |
| `scripts/run-tests.sh` | Installs the APK, starts Appium, runs the tests, collects logs |
| `tests/` | `01-onboarding`, `02-issue-pid-sdjwt`, `03-present-pid-one-sdjwt`, run in this order |
| `lib/` | Appium session and selectors, evidence capture, Wallet QA client |
| `artifacts/` | Output of a run: screenshots, UI hierarchies, `evidence.json` per test, Appium log, logcat |

## The wallet patch

Against `eudi-app-android-wallet-ui` at `428628bc` (Wallet Core 0.32.0), dev flavor only where
possible. Nothing is disabled; trust anchors are added.

- `network_security_config.xml`: trusts `deploy/tls/root.crt` (Wallet QA TLS Test Root,
  name-constrained to `localhost`) for `localhost` only, in addition to the system CAs.
- Dev `WalletCoreConfigImpl`: adds `https://localhost:3443/issuers/base` and
  `/issuers/issuer-dpop-v1` as configured issuers (the wallet only accepts offers from configured
  issuers), and uses `WalletQaTrust` as trust source for issuer certificates, signed issuer
  metadata and reader (verifier) certificates.
- Dev `WalletQaTrust`: a chain is trusted if it validates against
  `public/trust/wallet-qa-test-root.der`; otherwise the EU lists of trusted entities decide, as
  before. Wallet Core builds its ETSI trust source internally and does not expose it, so this
  class builds the same pipeline with the dev flavor's settings.
- Dev `WalletCoreConfigImpl`, Wallet QA issuers: no client authentication (EUDIPLO advertises
  `none`) and the `Standard` proof profile (plain JWT proofs; the default `Etsi` profile needs key
  attestations Wallet QA does not require).
- `WalletCoreDocumentsController`: logs why an offer or issuance failed (tag `WalletQa`).
- `core-logic/build.gradle.kts`: `nimbus-jose-jwt` 9.47 for the LoTE signature check in
  `WalletQaTrust` (the version Wallet Core 0.32.0 uses).

To change the patch: run `SKIP_GRADLE=1 scripts/build-wallet.sh`, edit the tree under
`.work/eudi-app-android-wallet-ui`, then regenerate it:

```sh
git -C .work/eudi-app-android-wallet-ui add -N core-logic/src/dev/java/eu/europa/ec/corelogic/config/WalletQaTrust.kt
git -C .work/eudi-app-android-wallet-ui diff -- . ':!network-logic/src/main/res/raw' ':!resources-logic/src/main/res/raw' > wallet/eudi-wallet-dev.patch
```

## CI

`.github/workflows/android-e2e.yml` (the only file outside this directory) runs on pushes to
`automation/**` branches and on demand:

1. `wallet-apk` builds the APK, cached on the patch, `build-wallet.sh` and the two roots.
2. `e2e` starts the stack, runs `pnpm smoke`, boots an API 34 `google_apis` x86_64 emulator
   with KVM and runs `emulator-check.sh` and `run-tests.sh`. The emulator starts fresh, so the
   onboarding test runs every time.
3. The artifacts `android-e2e-artifacts` (evidence, logs) and `wallet-dev-debug-apk` are
   attached to the run.

## Run it locally from a clean machine

Tested on macOS (Apple Silicon). Linux works the same with an x86_64 system image.

1. Install Docker Desktop, Node 22.19+ (`corepack enable` gives pnpm 11.20), a JDK 21 and the
   Android command-line tools (`sdkmanager`, `avdmanager`, `adb`, `emulator`). Set
   `ANDROID_HOME`.
2. Install the SDK parts and create an emulator:

   ```sh
   sdkmanager "platform-tools" "emulator" "system-images;android-34;google_apis;arm64-v8a"
   echo no | avdmanager create avd -n walletqa_api34 -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_6
   ```

   On x86_64 use `system-images;android-34;google_apis;x86_64`.
3. From the Wallet QA root: install, start the stack, smoke-test it.

   ```sh
   pnpm install
   automation/android/scripts/stack-up.sh
   pnpm smoke
   ```

   If port 3000 is taken, set `EUDIPLO_HOST_PORT=3010` and `EUDIPLO_BASE_URL=http://localhost:3010`
   in `.env` first.
4. Build the wallet (first build about 15 minutes):

   ```sh
   automation/android/scripts/build-wallet.sh
   ```

5. Start the emulator and run the tests:

   ```sh
   "$ANDROID_HOME/emulator/emulator" -avd walletqa_api34 -no-snapshot-save -no-boot-anim &
   cd automation/android
   pnpm install
   scripts/emulator-check.sh
   scripts/run-tests.sh
   ```

Results are in `automation/android/artifacts/`. Each test directory has the screenshots and UI
hierarchies taken when it answered a checklist question, and `evidence.json` with the question,
the answer, what was checked and the values found.

### Starting from a snapshot

The onboarding test skips itself when the wallet is already set up, so a snapshot taken after one
run saves the onboarding:

```sh
adb emu avd snapshot save wallet-onboarded       # after a run, with the emulator still up
"$ANDROID_HOME/emulator/emulator" -avd walletqa_api34 -snapshot wallet-onboarded -no-snapshot-save &
SKIP_INSTALL=1 scripts/run-tests.sh
```

`02` issues a new PID on every run, and `03` presents it, so both always run against the same
stack. A PID from an earlier stack cannot be presented (see FINDINGS.md).
