# Android wallet automation

Runs Wallet QA tests end to end with Appium driving the EU reference wallet in an
Android emulator. Work in progress; this README grows with each stage.

## Stage 1: stack and emulator (current)

The `Android wallet E2E` workflow (`.github/workflows/android-e2e.yml`) runs on every push
to an `automation/**` branch that touches this directory, and on demand (Actions tab, **Run
workflow**). It:

1. starts the Wallet QA stack (`scripts/stack-up.sh`) and runs `pnpm smoke`;
2. boots an Android 14 (API 34, `google_apis`, x86_64) emulator with KVM;
3. runs `adb reverse tcp:8443 tcp:8443` and `tcp:3443`, then checks from inside the
   emulator that both origins answer over HTTPS with a certificate chaining to
   `deploy/tls/root.crt` (`scripts/emulator-check.sh`);
4. uploads `artifacts/` (emulator screenshot, logcat, stack logs) as `android-e2e-artifacts`.

### Locally

Requires Docker, Node 22.19+, pnpm 11.20 and an Android SDK with a running emulator.

```sh
pnpm install                                 # in the Wallet QA root
automation/android/scripts/stack-up.sh       # creates .env with random secrets if missing
pnpm smoke
automation/android/scripts/emulator-check.sh # with one emulator running
```

If port 3000 is taken, set `EUDIPLO_HOST_PORT=3010` and `EUDIPLO_BASE_URL=http://localhost:3010`
in `.env` before `stack-up.sh`.
