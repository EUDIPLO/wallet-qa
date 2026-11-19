/**
 * Wallet QA test I-PID-SDJWT: the wallet accepts an offer for the QA PID (dc+sd-jwt) and stores it.
 *
 * Checklist answers come from what the test sees, never from constants:
 * - card-shown: the Documents tab lists the credential under the display name from the issuer
 *   metadata, with the credential's card image. The wallet labels its issuer logo
 *   "Issuer logo"; that image does not count as the card image.
 * - claims-shown (non-blocking): the detail view shows every top-level claim of the metadata, each
 *   under its display name rather than the raw claim name.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'webdriverio';
import { Evidence } from '../lib/evidence.ts';
import { assertVerdict } from '../lib/known-issues.ts';
import { credentialMetadata, topLevelClaims } from '../lib/metadata.ts';
import { client } from '../lib/wallet-qa.ts';
import {
  byTag, byText, nodes, openDeepLink, screens, scrollDown, startSession, tap,
  unlockIfLocked, visibleTexts, waitFor, waitForAny,
} from '../lib/wallet.ts';

const scenarioId = 'I-PID-SDJWT';
let driver: Browser;
const evidence = new Evidence('02-issue-pid-sdjwt');

before(async () => {
  driver = await startSession();
});
after(async () => {
  await driver?.deleteSession();
});

test(`${scenarioId}: the wallet accepts and stores the QA PID`, async () => {
  const qa = await client();
  const run = await qa.create({ scenarioId, timeoutSeconds: 600 });
  const step = await qa.waitForStep(run.id, 'issue');
  assert.ok(step?.interaction.uri, 'Wallet QA gave no offer link');
  evidence.write({ runId: run.id, offer: step.interaction.uri });

  const meta = await credentialMetadata('base', 'pid');

  await openDeepLink(driver, step.interaction.uri);
  await unlockIfLocked(driver);
  const opened = await waitForAny(driver, {
    offer: screens.offer, error: screens.error, blocked: screens.issuanceBlocked,
  }, 120_000);
  await evidence.step(driver, `offer-${opened}`);
  assert.equal(opened, 'offer', `Offer not shown: ${(await visibleTexts(driver)).join(' | ')}`);
  // The offer screen fills in once the wallet has resolved the offer and the issuer metadata.
  await waitFor(driver, byText(meta.name ?? 'PID'), 120_000);
  await evidence.step(driver, 'offer');

  await tap(driver, byText('Accept'));
  const outcome = await waitForAny(driver, { issued: screens.issued, error: screens.error }, 120_000);
  await evidence.step(driver, `issuance-${outcome}`);
  assert.equal(outcome, 'issued', `Issuance failed in the wallet: ${(await visibleTexts(driver)).join(' | ')}`);
  await tap(driver, byText('Close'));

  // card-shown: the Documents tab.
  await tap(driver, byTag('dashboard_screen_bottom_navigation_item_documents'));
  const entryTitle = await waitFor(driver, byText(meta.name ?? 'PID'));
  await evidence.observe(driver, 'card-shown',
    'Documents tab: an entry titled with the metadata display name and an image of the credential (not the issuer logo).',
    async () => {
      const all = await nodes(driver);
      const title = all.find((n) => n.text === meta.name);
      // The entry is the smallest clickable row around the title; take the row's band.
      const row = title && all
        .filter((n) => n.bounds[1] <= title.bounds[1] && n.bounds[3] >= title.bounds[3] && n.bounds[2] - n.bounds[0] > 600 && n.bounds[3] - n.bounds[1] < 400)
        .sort((a, b) => (a.bounds[3] - a.bounds[1]) - (b.bounds[3] - b.bounds[1]))[0];
      const band = row ? all.filter((n) => n.bounds[1] >= row.bounds[1] - 60 && n.bounds[3] <= row.bounds[3] + 80) : [];
      const images = band.filter((n) => n.desc && !n.text && /Image|View/.test(n.className)).map((n) => n.desc);
      const cardImages = images.filter((d) => d !== 'Issuer logo' && !/^Arrow/.test(d));
      return {
        holds: Boolean(title) && cardImages.length > 0,
        found: {
          expectedName: meta.name, nameShown: Boolean(title),
          imagesInEntry: images, cardImages,
          issuerDefinesCardImage: meta.hasBackgroundImage,
          entryTexts: band.map((n) => n.text).filter(Boolean),
        },
      };
    });

  // claims-shown: the document detail view, scrolled to the end.
  await entryTitle.click();
  await waitFor(driver, byText('DOCUMENT DATA'));
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    (await visibleTexts(driver)).forEach((t) => seen.add(t));
    if (!(await scrollDown(driver))) break;
  }
  await evidence.observe(driver, 'claims-shown',
    'Detail view: every top-level claim of the metadata appears, under its display name and not as the raw claim name.',
    async () => {
      const claims = topLevelClaims(meta);
      const shown = claims.filter((c) => seen.has(c.label ?? '') || seen.has(c.key));
      const missing = claims.filter((c) => !shown.includes(c)).map((c) => c.key);
      const rawLabels = claims.filter((c) => seen.has(c.key) && c.label !== c.key).map((c) => c.key);
      const withoutDisplayName = claims.filter((c) => !c.label).map((c) => c.key);
      return {
        holds: missing.length === 0 && rawLabels.length === 0,
        found: { missing, rawLabels, withoutDisplayNameInMetadata: withoutDisplayName, textsOnScreen: [...seen] },
      };
    });

  await qa.answer(run.id, evidence.answers());
  const final = await qa.get(run.id, 5_000);
  evidence.write({ runId: run.id, verdict: final.verdict, reason: final.reason, assertions: final.assertions });
  await assertVerdict(qa, scenarioId, run.id);
});
