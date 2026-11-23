// The Angular preview (web/): its page-contract texts and attributes, checked against real run
// views from the engine, and how Express serves it under /next/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { Engine, liveRun } from '../src/testing/engine.js';
import type { Backend } from '../src/testing/eudiplo.js';
import { FileRunStore } from '../src/testing/store.js';
import type { SessionEvidence } from '../src/testing/types.js';
import {
  answersToSend,
  awaitingWallet,
  badgeText,
  contractAttributes,
  qrValue,
  reasonText,
  stepText,
  transactionCodeText,
  verdictTone,
  walletLink,
  type LiveRun,
} from '../web/src/app/live-run/run-view.js';
import { testWorkspaces, WS } from './helpers.js';

class FakeBackend implements Backend {
  sessions = new Map<string, SessionEvidence>();
  async start() {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { status: 'active' });
    return { sessionId, uri: `openid-credential-offer://?credential_offer_uri=https%3A%2F%2Feudiplo.test%2F${sessionId}` };
  }
  async session(id: string) { return structuredClone(this.sessions.get(id)!); }
  async deleteSession(id: string) { this.sessions.delete(id); }
  async setStatus() {}
  async health() {}
  async requestObject() { return ''; }
}

async function setup() {
  const store = await new FileRunStore().init();
  const backend = new FakeBackend();
  const engine = new Engine(store, await testWorkspaces(), backend, {
    publicOrigin: 'https://qa.test',
    retentionMs: 3600000,
    pollMs: 0,
    versions: { catalog: '', sdk: '7.6.0', eudiplo: '7.6.0' },
  });
  return { store, backend, engine };
}

/** The run view the page gets from GET /v1/runs/:id. */
const view = (run: Parameters<typeof liveRun>[0]) => JSON.parse(JSON.stringify(liveRun(run))) as LiveRun;

test('preview: a running issuance shows its status, transaction code and an Open wallet link', async () => {
  const { engine, store } = await setup();
  const { run } = await engine.create({ workspaceId: WS, scenarioId: 'I-EAA-TX' });
  const live = view((await store.get(run.id))!);
  assert.equal(badgeText(live), 'Status: awaiting wallet');
  assert.equal(stepText(live), `Step ${live.currentStep.id}: awaiting wallet`);
  assert.equal(reasonText(live), 'Waiting for the wallet. The result updates automatically.');
  assert.equal(awaitingWallet(live), true);
  assert.match(walletLink(live)!, /^openid-credential-offer:/);
  assert.equal(qrValue(live), live.currentStep.interaction.crossDeviceUri ?? live.currentStep.interaction.uri);
  assert.match(transactionCodeText(live), /^Transaction code: \S+$/);
  assert.deepEqual(contractAttributes(live, 'fresh'), {
    runId: run.id, completed: 'false', passed: 'pending', verdict: 'pending', attested: 'false', sync: 'fresh',
  });
  assert.equal(verdictTone(live), 'neutral');
});

test('preview: after the wallet, the checklist and then the verdict; no wallet link', async () => {
  const { engine, store, backend } = await setup();
  const { run } = await engine.create({ workspaceId: WS, scenarioId: 'I-EAA-NOTX' });
  backend.sessions.set((await store.get(run.id))!.steps[0].sessionId!, { status: 'completed' });
  await engine.tick(run.id);
  const tester = view((await store.get(run.id))!);
  assert.equal(badgeText(tester), 'Status: awaiting tester');
  assert.equal(reasonText(tester), 'The server checks passed. Answer the checklist to finish the run.');
  assert.equal(walletLink(tester), undefined);
  assert.ok(tester.checklist.length > 0);
  const at = new Date().toISOString();
  const checks = (await store.get(run.id))!.scenario.manual ?? [];
  await engine.answer(run.id, Object.fromEntries(checks.map((check) => [check.id, { answer: check.expect, at }])));
  const live = view((await store.get(run.id))!);
  assert.equal(live.completed, true, live.reason ?? live.state);
  assert.match(badgeText(live), /^Verdict: \w+/);
  assert.equal(walletLink(live), undefined);
  assert.equal(contractAttributes(live, 'fresh').completed, 'true');
  assert.equal(contractAttributes(live, 'fresh').verdict, live.verdict);
});

test('preview: texts and attributes without a run, and for attested and failed runs', () => {
  assert.equal(badgeText(undefined), 'Verdict: none');
  assert.deepEqual(contractAttributes(undefined, 'idle'), {
    runId: '', completed: 'false', passed: 'pending', verdict: 'pending', attested: 'false', sync: 'idle',
  });
  assert.equal(contractAttributes(undefined, 'error', 'unavailable').verdict, 'unavailable');
  const base = {
    id: 'r1', scenarioId: 'P-X', scenarioLabel: 'X', state: 'finished', completed: true, passed: true,
    verdict: 'passed', attested: true, reason: null, awaitingTester: false, noEvidence: null,
    currentStep: { id: 'present', state: 'finished', instruction: null, interaction: { uri: 'openid4vp://x', crossDeviceUri: null, transactionCode: null } },
    checklist: [], controls: [], assertions: [], createdAt: '',
  } satisfies LiveRun;
  assert.equal(badgeText(base), 'Verdict: passed (tester-attested)');
  assert.equal(contractAttributes(base, 'fresh').attested, 'true');
  assert.equal(verdictTone(base), 'passed');
  assert.equal(verdictTone({ ...base, verdict: 'failed', passed: false }), 'failed');
  assert.equal(verdictTone({ ...base, verdict: 'skipped', passed: false }), 'neutral');
  const tester = { ...base, state: 'awaiting_tester', completed: false, passed: null, verdict: null, attested: null, awaitingTester: true } satisfies LiveRun;
  assert.equal(reasonText(tester), 'The server checks passed. Answer the checklist to finish the run.');
  assert.equal(reasonText({ ...tester, noEvidence: 'EUDIPLO has no evidence' }), 'EUDIPLO has no evidence. Answer the checklist to finish the run.');
});

test('preview: Open wallet only navigates to wallet hand-off schemes', () => {
  const run = (uri: string) => ({
    id: 'r1', scenarioId: 'P-X', scenarioLabel: 'X', state: 'awaiting_wallet', completed: false, passed: null,
    verdict: null, attested: null, reason: null, awaitingTester: false, noEvidence: null,
    currentStep: { id: 'present', state: 'awaiting_wallet', instruction: null, interaction: { uri, crossDeviceUri: null, transactionCode: null } },
    checklist: [], controls: [], assertions: [], createdAt: '',
  }) satisfies LiveRun;
  for (const uri of ['openid4vp://?a=1', 'openid-credential-offer://?a=1', 'haip://?a=1', 'eudi-openid4vp://?a=1', 'https://wallet.test/x'])
    assert.equal(walletLink(run(uri)), uri);
  for (const uri of ['javascript:alert(1)', 'http://wallet.test/x', 'not a url'])
    assert.equal(walletLink(run(uri)), undefined, uri);
});

test('preview: only answered checklist items are sent, without empty notes', () => {
  assert.deepEqual(answersToSend({ a: { answer: 'yes', note: '' }, b: { note: 'only a note' }, c: { answer: 'no', note: 'seen' } }), {
    a: { answer: 'yes' },
    c: { answer: 'no', note: 'seen' },
  });
});

test('HTTP: /next serves the built preview and falls back to its index.html', async () => {
  const { engine } = await setup();
  const webDir = await mkdtemp(path.join(os.tmpdir(), 'wallet-qa-web-'));
  await writeFile(path.join(webDir, 'index.html'), '<qa-root></qa-root>');
  await writeFile(path.join(webDir, 'main-ABC.js'), 'console.log(1)');
  const listen = async (app: ReturnType<typeof createApp>) => {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(resolve)) };
  };
  const withWeb = await listen(createApp(engine, { publicDir: path.resolve('public'), publicOrigin: 'http://localhost', webDir }));
  const without = await listen(createApp(engine, { publicDir: path.resolve('public'), publicOrigin: 'http://localhost' }));
  try {
    for (const route of ['/next', '/next/', `/next/w/${WS}?scenario=I-EAA-NOTX&e2e=1`]) {
      const response = await fetch(withWeb.base + route);
      assert.equal(response.status, 200, route);
      assert.equal(await response.text(), '<qa-root></qa-root>', route);
    }
    assert.match(await (await fetch(`${withWeb.base}/next/main-ABC.js`)).text(), /console/);
    assert.equal((await fetch(`${withWeb.base}/next/missing.js`)).status, 404);
    // The classic page and the API stay where they are.
    assert.match(await (await fetch(`${withWeb.base}/w/${WS}`)).text(), /<title>Wallet QA<\/title>/);
    assert.equal((await fetch(`${withWeb.base}/v1/scenarios`)).status, 200);
    assert.equal((await fetch(`${without.base}/next/w/${WS}`)).status, 404);
  } finally {
    await withWeb.close();
    await without.close();
    await rm(webDir, { recursive: true, force: true });
  }
});
