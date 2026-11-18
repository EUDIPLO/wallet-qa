# Paradym adapter

Maestro adapter for [Paradym](https://paradym.id) (`id.paradym.wallet`), written from the
screens of **Paradym 1.23.0 from the Play Store on a Pixel 9 Pro XL, Android 17**, against the
hosted Wallet QA instance.

| File | Does |
| --- | --- |
| `test.yaml` | The generic loop, unchanged from `example/`. |
| `strings.js` | Paradym's screen texts in German and English, for the selectors. |
| `open-in-wallet.yaml` | Picks Paradym in Android's app chooser ("just once", never as default), cancels the face unlock prompt, and unlocks the app with its PIN. |
| `enter-pin.yaml` | Taps `WALLET_PIN` on Paradym's number pad; without it, waits two minutes for a person to enter the PIN. |
| `accept-offer.yaml` | Issuer trust screen → card offered → "store this card?" → success. |
| `share.yaml` | Verifier trust screen → review the request → share → PIN. Paradym then redirects to the browser. |
| `refuse.yaml` | Not mapped yet (copy of the example). |

## Languages

Paradym's own screens have no resource ids, except `entity-image-loaded` on the issuer logo.
The flows therefore match texts, from `strings.js`. Each selector matches the text in every
language listed there (German and English), so the phone and Paradym can be in either
language. `WALLET_LANG=en` (or `de`) limits the selectors to one language. When Paradym shows
none of the expected screens, the flow fails with "Paradym shows no ... screen this adapter
knows" and takes the screenshot `paradym-unknown-screen`.

Android's own screens (the app chooser, the face unlock prompt) are matched by resource id
(`android:id/button_once`, `com.android.systemui:id/close_button`), in any language.
The digit keys of Paradym's PIN pad are matched by their digit.

For another language, add a block to `strings.js` with the texts read from
`maestro hierarchy` (not from screenshots) on each screen. Maestro matches them as regexes,
so escape `?`, `.`, `(` and the like.

## Run

Set `WALLET_APP_ID=id.paradym.wallet` (and `WALLET_NAME`, `WALLET_VERSION`, optionally
`WALLET_PIN` and `WALLET_LANG`) in `maestro/.env`, since `run.sh` takes them from there, then:

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
  issuance. On a phone with face unlock it shows Android's face prompt before the PIN pad.

### English (2026-11-18)

Same phone, Paradym set to English, the whole loop through `maestro test`:

| Test | Result | Why |
| --- | --- | --- |
| I-EAA-NOTX | flow passed | Every screen matched by the English texts; card stored, `claims-shown` and `card-shown` answered. |
| I-PID-SDJWT | failed | Same rejection as in German, on the "Something went wrong" screen. Stepped through by hand. |
| P-EAA-ONE | failed | The flow reached the PIN confirmation, the PIN was entered, but EUDIPLO recorded `Wallet error: access_denied`. Not explained yet; in German the presentation completed. |
