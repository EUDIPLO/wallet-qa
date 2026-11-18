// Paradym's screen texts per app language, for the selectors in this folder.
//
// Paradym's own screens have no resource ids (except the issuer logo), so the flows match
// texts. Each entry below becomes a regex that matches the text in every language listed,
// so the adapter works whatever language Paradym shows. WALLET_LANG=de (or en, ...) limits it
// to one language.
//
// Maestro matches selectors as full-string regexes, ignoring case: escape . ? ( ) [ ] + * |
// in the texts. Read new texts from `maestro hierarchy`, not from screenshots.
//
// Sets output.t.<key> for the flows, e.g. tapOn: ${output.t.trustYes}.

const TEXTS = {
  de: {
    // Issuer or verifier trust screen
    trustYes: 'Ja, fortfahren',
    verifierUnverified: 'Organisation nicht verifiziert',
    // Issuance
    offered: 'Karte angeboten',
    next: 'Weiter',
    storeCard: 'Möchtest du diese Karte speichern\\?',
    accept: 'Akzeptieren',
    success: 'Erfolgreich!',
    toWallet: 'Zur Wallet',
    // Presentation
    reviewRequest: 'Anfrage überprüfen',
    share: 'Teilen',
    // PIN pad: unlock the app, confirm a presentation
    unlockPin: 'Gib deine App-PIN ein',
    confirmPin: 'Sende Daten mit deinem PIN-Code',
    // Paradym's error screen (rejected credential, failed presentation)
    error: 'Etwas ist schiefgegangen',
  },
  en: {
    trustYes: 'Yes, continue',
    verifierUnverified: 'Organization not verified',
    offered: 'Card offered',
    next: 'Continue',
    storeCard: 'Do you want to store this card\\?',
    accept: 'Accept',
    success: 'Success!',
    toWallet: 'Go to wallet',
    reviewRequest: 'Review the request',
    share: 'Share',
    unlockPin: 'Enter your app PIN code',
    confirmPin: 'Send data with your PIN code',
    error: 'Something went wrong',
  },
};

const wanted =
  typeof WALLET_LANG === 'undefined' || !WALLET_LANG
    ? Object.keys(TEXTS)
    : String(WALLET_LANG).toLowerCase().split(/[\s,]+/).filter(Boolean);
for (const lang of wanted)
  if (!TEXTS[lang])
    throw new Error(
      'The Paradym adapter has no texts for WALLET_LANG=' + lang +
        '; it knows ' + Object.keys(TEXTS).join(', ') + ' (maestro/wallets/paradym/strings.js)',
    );

const t = {};
for (const key of Object.keys(TEXTS[wanted[0]])) {
  const variants = [];
  for (const lang of wanted) if (variants.indexOf(TEXTS[lang][key]) < 0) variants.push(TEXTS[lang][key]);
  t[key] = variants.length === 1 ? variants[0] : '(?:' + variants.join('|') + ')';
}
output.t = t;
output.languages = wanted.join(', ');
