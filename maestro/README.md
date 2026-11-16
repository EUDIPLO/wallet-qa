# Maestro flows (proof of concept)

[Maestro](https://maestro.dev/) drives a wallet through Wallet QA tests, without a tester.
Wallet QA still decides the verdict from EUDIPLO's evidence. The flow only plays the user: it
opens the offer or request link, taps through the wallet, and answers the checklist questions
it can check on screen.

```text
run.sh ──► POST /v1/workspaces            one workspace per list of tests
  └─ maestro test wallets/<wallet>/test.yaml   (per test)
       ├─ wallet-qa.js start   POST /v1/workspaces/:ws/runs → output.qa.step.uri
       ├─ per step: openLink uri → accept-offer | share | refuse (wallet adapter)
       │            wallet-qa.js step     wait until EUDIPLO saw the wallet
       └─ wallet-qa.js finish  send checklist answers, wait for the verdict, fail unless passed
```

Same-device links replace QR scanning, so the flows run on emulators and simulators without
a camera.

## Layout

| Path | Purpose |
| --- | --- |
| `scripts/wallet-qa.js` | Talks to the Wallet QA API (`runScript`). Shared by every wallet. |
| `wallets/<wallet>/test.yaml` | The test loop: start, one pass per wallet step, finish. Same for every wallet. |
| `wallets/<wallet>/accept-offer.yaml` | Accept a credential offer, enter the transaction code and PIN. |
| `wallets/<wallet>/share.yaml` | Consent to a presentation request. |
| `wallets/<wallet>/refuse.yaml` | A request the wallet must refuse: note what the wallet shows. |
| `run.sh` | Runs a list of tests in one workspace and saves the JUnit report. |

`wallets/example` has example selectors (`Add`, `Share`, `Send data`, …). For a real wallet,
copy the folder and change the three adapter flows. `test.yaml` stays as it is.

The adapters answer checklist questions through `output.qa.answers`, for example
`evalScript: ${output.qa.answers['verifier-shown'] = 'yes'}` once the consent screen names
the verifier. Wallet QA marks those answers "Answered by Maestro from the wallet screen".
Answers for questions a test does not ask are dropped. A test whose blocking question
has no automatic answer stays open for a tester, and the flow fails with that question
named.

## Run

Needs the [Maestro CLI](https://docs.maestro.dev/getting-started/installing-maestro), a
booted emulator or simulator with the wallet installed (and onboarded, if it needs a PID),
and a Wallet QA instance the device can reach.

```bash
cp maestro/.env.example maestro/.env      # wallet app id, PIN, Wallet QA URL and login
maestro/run.sh example I-PID-SDJWT P-PID-ALL-SDJWT
```

A single test, without `run.sh`:

```bash
maestro test -e WALLET_APP_ID=com.example.wallet -e SCENARIO=I-EAA-NOTX \
  -e QA_URL=http://127.0.0.1:8787 maestro/wallets/example/test.yaml
```

Order matters: a test with *Run first* on the page (for example `P-PID-ALL-SDJWT`, which
needs `I-PID-SDJWT`) uses the credential an earlier test put in the wallet, so `run.sh`
keeps the order you give.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCENARIO` | | Test id from the catalog (`GET /v1/scenarios`). |
| `WALLET_APP_ID` | | Bundle id or package name of the wallet. |
| `WALLET_PIN` | unset | Entered when the wallet asks for its PIN. |
| `QA_URL` | `http://127.0.0.1:8787` | Wallet QA, as the machine running Maestro reaches it. |
| `QA_USER`, `QA_PASSWORD` | unset | The team login of a hosted instance. |
| `WORKSPACE` | new one | Workspace for the run (`run.sh` sets it). |
| `QA_STEP_TIMEOUT` | `120` | Seconds to wait for EUDIPLO to see the wallet finish a step. |

### Reaching the stack from a device

- **Hosted instance**: nothing to do; the links point to public HTTPS hosts.
- **Local stack, iOS simulator**: `localhost` is the Mac. The simulator must trust the
  test TLS root (`scripts/trust-simulator.sh`).
- **Local stack, Android emulator**: forward the ports the links use:
  `adb reverse tcp:3443 tcp:3443 && adb reverse tcp:8443 tcp:8443 && adb reverse tcp:8787 tcp:8787`.
  The emulator must also trust `deploy/tls/root.crt`.

## Limits of this proof of concept

- Only the example adapter exists; its selectors match no particular wallet.
- Wallet onboarding (PID, PIN setup) is not part of the flows; prepare the wallet once.
- Steps with run controls (`P-REVOKED`, `P-SUSPENDED`) need a control call between steps.
- Biometric prompts and system dialogs beyond the iOS "Open in …" prompt are not handled.
- Real devices and device farms: Maestro runs flows on emulators and simulators. For real
  devices, use a cloud that runs Maestro flows or Appium (see `docs/design.md`).
- Maestro must run its JavaScript with GraalJS (the default in current versions).
