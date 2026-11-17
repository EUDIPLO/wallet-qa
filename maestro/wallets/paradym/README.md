# Paradym adapter

Maestro adapter for [Paradym](https://paradym.id) (`id.paradym.wallet`), written from the
screens of **Paradym 1.23.0 from the Play Store on a Pixel 9 Pro XL, Android 17**, against the
hosted Wallet QA instance.

The selectors are Paradym's **German** texts, so the phone's language must be German.

| File | Does |
| --- | --- |
| `test.yaml` | The generic loop, unchanged from `example/`. |
| `open-in-wallet.yaml` | Picks Paradym in Android's app chooser ("Nur diesmal", never as default) and unlocks the app. |
| `enter-pin.yaml` | Taps `WALLET_PIN` on Paradym's number pad; without it, waits two minutes for a person to enter the PIN. |
| `accept-offer.yaml` | Issuer trust screen → "Karte angeboten" → "Möchtest du diese Karte speichern?" → "Erfolgreich!". |
| `share.yaml` | Verifier trust screen → "Anfrage überprüfen" → "Teilen" → PIN. Paradym then redirects to the browser. |
| `refuse.yaml` | Not mapped yet (copy of the example). |

Set `WALLET_APP_ID=id.paradym.wallet` (and `WALLET_NAME`, `WALLET_VERSION`, optionally
`WALLET_PIN`) in `maestro/.env`, since `run.sh` takes them from there, then:

```bash
maestro/run.sh paradym I-EAA-NOTX P-EAA-ONE
```

## Results so far (2026-11-16)

| Test | Result | Why |
| --- | --- | --- |
| I-EAA-NOTX | passed | Card stored with image and claims, no PIN asked. Run fully by Maestro. |
| I-PID-SDJWT | failed | Paradym rejects the credential: *"The status list signer chain does not match the credential issuer chain, and no dedicated trusted status certificates were configured for the trusted issuer."* The QA issuer signs status lists with its own `statusList` key chain (listed as revocation service in `trust-lists/qa-issuers.json`). |
| I-PID-MDOC | failed | *"Country name (C) must be present in the issuer certificate's subject distinguished name"* (ISO 18013-5). `scripts/generate-fixtures.mjs` set only `/CN=<host>`; #8 adds `C` and `O`, not yet redeployed. |
| P-EAA-ONE | failed | Presentation completed and the protocol check passed, but Paradym shows "Organisation nicht verifiziert" with no verifier name, so `verifier-shown` is "no". |

Observations:

- Paradym shows the issuer and the verifier as "Unbekannte Organisation" because it does not
  trust the Wallet QA test roots. Accepting still works.
- Paradym asks for its app PIN to unlock (at times) and to confirm every presentation, not on
  issuance.
