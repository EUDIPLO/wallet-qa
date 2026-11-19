/**
 * Wallet QA test P-PID-ONE-SDJWT: the wallet presents only given_name from the QA PID that
 * 02-issue-pid-sdjwt issued against the same stack.
 *
 * Checklist answer from what the test sees:
 * - verifier-shown: the consent screen names the verifier (a name next to the "Verified" badge,
 *   no "could not be verified" warning) and, expanded, lists exactly the requested attributes:
 *   the display name of given_name from the issuer metadata, nothing else.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'webdriverio';
import { Evidence } from '../lib/evidence.ts';
import { assertVerdict } from '../lib/known-issues.ts';
import { credentialMetadata } from '../lib/metadata.ts';
import { client } from '../lib/wallet-qa.ts';
import {
  byDesc, byTag, byText, byTextContains, enterPin, inside, isShown, nodes, openDeepLink, screens,
  startSession, tap, unlockIfLocked, visibleTexts, waitFor, waitForAny,
} from '../lib/wallet.ts';

const scenarioId = 'P-PID-ONE-SDJWT';
const requested = [['given_name']];
let driver: Browser;
const evidence = new Evidence('03-present-pid-one-sdjwt');

before(async () => {
  driver = await startSession();
});
after(async () => {
  await driver?.deleteSession();
});

test(`${scenarioId}: the wallet discloses only given_name`, async () => {
  const qa = await client();
  const run = await qa.create({ scenarioId, timeoutSeconds: 600 });
  const step = await qa.waitForStep(run.id, 'present');
  assert.ok(step?.interaction.uri, 'Wallet QA gave no presentation request link');
  evidence.write({ runId: run.id, request: step.interaction.uri });

  const meta = await credentialMetadata('base', 'pid');
  const expectedLabels = requested.map((path) =>
    meta.claims.find((c) => c.path.join('.') === path.join('.'))?.label ?? path.join('.'));

  await openDeepLink(driver, step.interaction.uri);
  await unlockIfLocked(driver);
  const opened = await waitForAny(driver, { request: screens.request, error: screens.error }, 120_000);
  await evidence.step(driver, `request-${opened}`);
  assert.equal(opened, 'request', `Request not shown: ${(await visibleTexts(driver)).join(' | ')}`);

  // Expand the requested document to see its attributes.
  const document = await waitFor(driver, byTag('request_screen_requested_document_0'));
  await (await document.$(byText('View details'))).click();
  await driver.pause(1_000);

  await evidence.observe(driver, 'verifier-shown',
    'Consent screen: a verifier name next to the "Verified" badge, no untrusted-verifier warning, and the expanded document lists exactly the display names of the requested claims.',
    async () => {
      const all = await nodes(driver);
      const badge = all.find((n) => n.desc === 'Verified');
      const verifierName = badge
        ? all.find((n) => n.text && Math.abs(n.bounds[1] - badge.bounds[1]) < 40 && n.bounds[0] > badge.bounds[0])?.text
        : undefined;
      const warning = await isShown(driver, byTextContains('could not be verified'));
      const container = all.find((n) => n.id.endsWith('request_screen_requested_document_0'));
      const texts = container ? inside(all, container).map((n) => n.text).filter(Boolean) : [];
      // Texts after "View details" alternate label, value.
      const details = texts.slice(texts.indexOf('View details') + 1);
      const labels = details.filter((_, i) => i % 2 === 0);
      const exact = labels.length === expectedLabels.length && expectedLabels.every((l) => labels.includes(l));
      return {
        holds: Boolean(verifierName) && !warning && exact,
        found: { verifierName, verifiedBadge: Boolean(badge), untrustedWarning: warning, document: texts[0], labels, expectedLabels, details },
      };
    });

  await tap(driver, byText('Share'));
  await waitFor(driver, screens.pinConfirmAction, 60_000);
  await enterPin(driver);
  const outcome = await waitForAny(driver, {
    shared: screens.shared, rejected: screens.rejectedByVerifier, error: screens.error,
  }, 120_000);
  await evidence.step(driver, `presentation-${outcome}`);
  assert.equal(outcome, 'shared', `Presentation did not succeed: ${(await visibleTexts(driver)).join(' | ')}`);

  await qa.answer(run.id, evidence.answers());
  const final = await qa.get(run.id, 5_000);
  evidence.write({ runId: run.id, verdict: final.verdict, reason: final.reason, assertions: final.assertions });
  await assertVerdict(qa, scenarioId, run.id);

  // Back to the wallet's home so a later test starts from a known screen.
  if (await isShown(driver, byText('Close'))) await tap(driver, byText('Close'));
  else if (await isShown(driver, byDesc('Close'))) await tap(driver, byDesc('Close'));
});
