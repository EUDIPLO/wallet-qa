import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { FileRunStore, FileWorkspaceStore } from '../src/testing/store.js';
import { Engine, liveRun } from '../src/testing/engine.js';
import { SCENARIOS } from '../src/testing/catalog.js';
import { createApp } from '../src/app.js';
import type { Backend } from '../src/testing/eudiplo.js';
import type { ManualAnswer, SessionEvidence } from '../src/testing/types.js';
import { WalletQaClient } from '../src/client.js';
import { testWorkspaces, WS } from './helpers.js';

class FakeBackend implements Backend {
  sessions = new Map<string, SessionEvidence>();
  statusUpdates: { sessionId: string; status: number }[] = [];
  async start() {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { status: 'active' });
    return { sessionId, uri: `openid4vp://?request_uri=${encodeURIComponent('https://eudiplo.test/r/' + sessionId)}` };
  }
  async session(id: string) { return structuredClone(this.sessions.get(id)!); }
  async deleteSession(id: string) { this.sessions.delete(id); }
  async setStatus(sessionId: string, status: 0 | 1 | 2) { this.statusUpdates.push({ sessionId, status }); }
  async health() {}
  async requestObject(): Promise<string> { throw new Error('not used'); }
}
const versions = { catalog: '', sdk: 'test', eudiplo: 'test' };
async function setup() {
  const store = await new FileRunStore().init();
  const backend = new FakeBackend();
  const engine = new Engine(store, await testWorkspaces(), backend, { publicOrigin: 'https://qa.test', retentionMs: 3600000, pollMs: 0, versions });
  const start = async (scenarioId: string) => (await engine.create({ workspaceId: WS, scenarioId })).run;
  const session = async (runId: string, evidence: SessionEvidence) => {
    const run = (await store.get(runId))!;
    backend.sessions.set(run.steps[run.currentStep].sessionId!, evidence);
    await engine.tick(runId);
    return (await store.get(runId))!;
  };
  const answer = (runId: string, answers: Record<string, 'yes' | 'no'>) =>
    engine.answer(runId, Object.fromEntries(Object.entries(answers).map(([k, a]): [string, ManualAnswer] => [k, { answer: a, at: new Date().toISOString() }])));
  return { store, backend, engine, start, session, answer };
}

test('every catalog entry is consistent', () => {
  const ids = new Set<string>();
  for (const scenario of SCENARIOS) {
    assert.ok(!ids.has(scenario.id), `duplicate ${scenario.id}`); ids.add(scenario.id);
    const checks = new Set((scenario.manual ?? []).map((m) => m.id));
    assert.equal(checks.size, (scenario.manual ?? []).length, `duplicate checklist id in ${scenario.id}`);
    for (const control of scenario.controls ?? []) {
      assert.ok(scenario.steps.some((s) => s.id === control.stepId), `${scenario.id}: control ${control.id} points at a missing step`);
      if (control.availableFromStep) assert.ok(scenario.steps.some((s) => s.id === control.availableFromStep));
    }
    for (const required of scenario.requires ?? []) assert.ok(SCENARIOS.some((s) => s.id === required), `${scenario.id} requires unknown ${required}`);
    // Tests that only the tester can decide must have something for the tester to answer.
    if (scenario.fallback === 'attest' && scenario.availability === 'ready')
      assert.ok((scenario.manual ?? []).some((m) => m.blocking !== false), `${scenario.id}: attest without a blocking check`);
  }
});

test('a positive run waits for the checklist after the server passed it', async () => {
  const { start, session, answer } = await setup();
  const run = await start('I-EAA-NOTX');
  const done = await session(run.id, { status: 'completed' });
  assert.equal(done.state, 'awaiting_tester');
  assert.equal(done.verdict, null);
  const passed = await answer(run.id, { 'card-shown': 'yes' });
  assert.equal(passed.verdict, 'passed');
  assert.equal(passed.attested, false);
  assert.equal(liveRun(passed).checklist[0].answer, 'yes');
});

test('a blocking answer that differs from the expectation fails the run', async () => {
  const { start, session, answer } = await setup();
  const run = await start('I-EAA-NOTX');
  await session(run.id, { status: 'completed' });
  const failed = await answer(run.id, { 'card-shown': 'no' });
  assert.equal(failed.verdict, 'failed');
  assert.match(failed.reason!, /Tester check failed/);
});

test('non-blocking answers are reported but never decide', async () => {
  const { start, session, answer } = await setup();
  const run = await start('I-PID-SDJWT');
  await session(run.id, { status: 'completed' });
  const result = await answer(run.id, { 'card-shown': 'yes', 'claims-shown': 'no' });
  assert.equal(result.verdict, 'passed');
  assert.equal(result.manual.find((a) => a.id === 'claims-shown')!.status, 'failed');
});

test('the tester cannot override a server failure', async () => {
  const { start, session, answer } = await setup();
  const run = await start('R-NOT-AVAIL');
  const failed = await session(run.id, { status: 'completed' });
  assert.equal(failed.verdict, 'failed');
  await assert.rejects(answer(run.id, { refused: 'yes' }), /finished/);
});

test('a matching wallet error code passes a rejection; the checklist still has to be answered', async () => {
  const { start, session, answer } = await setup();
  const run = await start('R-NOT-AVAIL');
  const waiting = await session(run.id, { status: 'failed', walletErrorCode: 'credential_unavailable' });
  assert.equal(waiting.state, 'awaiting_tester');
  const passed = await answer(run.id, { refused: 'yes' });
  assert.equal(passed.verdict, 'passed');
  assert.equal(passed.attested, false);
});

test('a silent rejection is attested only after the wallet engaged with the request', async () => {
  const { start, session, answer, store } = await setup();
  const run = await start('R-NOT-AVAIL');
  // Answering before the wallet even fetched the request proves nothing.
  const early = await answer(run.id, { refused: 'yes' });
  assert.equal(early.verdict, null);
  const fetched = await session(run.id, { status: 'fetched' });
  assert.equal(fetched.verdict, 'passed');
  assert.equal(fetched.attested, true);
  assert.match(fetched.reason!, /Tester-attested/);
  assert.equal(liveRun((await store.get(run.id))!).attested, true);
});

test('at the deadline, attest scenarios wait for the tester; others are inconclusive', async () => {
  const { start, engine, store, answer } = await setup();
  const negative = await start('R-SIG');
  const positive = await start('P-SELECTIVE');
  for (const id of [negative.id, positive.id]) {
    await store.update(id, async (r) => { r.deadlineAt = new Date(Date.now() - 1).toISOString(); });
    await engine.tick(id);
  }
  assert.equal((await store.get(positive.id))!.verdict, 'inconclusive');
  const waiting = (await store.get(negative.id))!;
  assert.equal(waiting.state, 'awaiting_tester');
  assert.match(waiting.serverNoEvidence!, /Deadline/);
  const result = await answer(negative.id, { refused: 'yes' });
  assert.equal(result.verdict, 'passed');
  assert.equal(result.attested, true);
});

test('revocation control updates EUDIPLO and the verifier rejection passes the step', async () => {
  const { start, session, answer, engine, backend } = await setup();
  const run = await start('P-REVOKED');
  await assert.rejects(engine.control(run.id, 'revoke'), /not available/);
  const second = await session(run.id, { status: 'completed' });
  await engine.tick(run.id);
  assert.equal(second.currentStep, 1);
  const issuedSession = second.steps[0].sessionId!;
  const controlled = await engine.control(run.id, 'revoke');
  assert.deepEqual(backend.statusUpdates, [{ sessionId: issuedSession, status: 1 }]);
  assert.ok(liveRun(controlled).controls[0].usedAt);
  const rejected = await session(run.id, { status: 'failed' });
  assert.equal(rejected.steps[1].assertions.find((a) => a.id === 'protocol')!.status, 'passed');
  const done = await answer(run.id, { informed: 'yes' });
  assert.equal(done.verdict, 'passed');
  assert.equal(done.attested, false);
});

test('a verifier that accepts a revoked credential fails the run', async () => {
  const { start, session, engine } = await setup();
  const run = await start('P-REVOKED');
  await session(run.id, { status: 'completed' }); await engine.tick(run.id);
  const accepted = await session(run.id, { status: 'completed' });
  assert.equal(accepted.verdict, 'failed');
});

test('disclosure rules check presence, values, absence and extra claims (sd-jwt nested, mdoc flattened)', async () => {
  const { start, session } = await setup();
  const mdocAll = Object.fromEntries([
    'family_name', 'given_name', 'birth_date', 'age_over_12', 'age_over_14', 'age_over_16', 'age_over_18', 'age_over_21', 'age_over_65',
    'age_in_years', 'age_birth_year', 'family_name_birth', 'birth_place', 'nationality', 'resident_street', 'resident_postal_code',
    'resident_city', 'resident_country', 'issuing_authority', 'issuing_country',
  ].map((k) => [k, k === 'given_name' ? 'ERIKA' : k === 'age_over_18' ? true : 'x']));
  const ok = await start('P-PID-ALL-MDOC');
  const okRun = await session(ok.id, { status: 'completed', credentials: [{ id: 'pid-mso-mdoc', values: [mdocAll] }] });
  assert.equal(okRun.steps[0].assertions.find((a) => a.id === 'disclosure')!.status, 'passed');

  const missing = await start('P-PID-ALL-MDOC');
  const { birth_date: _omitted, ...withoutBirthDate } = mdocAll;
  const missingRun = await session(missing.id, { status: 'completed', credentials: [{ id: 'pid-mso-mdoc', values: [withoutBirthDate] }] });
  assert.equal(missingRun.verdict, 'failed');
  assert.match(missingRun.steps[0].assertions.find((a) => a.id === 'disclosure')!.actual!, /missing eu\.europa\.ec\.eudi\.pid\.1\.birth_date/);

  const leak = await start('P-PID-AGE-SDJWT');
  const leakRun = await session(leak.id, { status: 'completed', credentials: [{ id: 'pid-sd-jwt', values: [{ age_equal_or_over: { '18': true }, birthdate: '1964-08-12', iss: 'x', cnf: {} }] }] });
  assert.equal(leakRun.verdict, 'failed');
  assert.match(leakRun.steps[0].assertions.find((a) => a.id === 'disclosure')!.actual!, /must not disclose birthdate/);

  const age = await start('P-PID-AGE-SDJWT');
  const ageRun = await session(age.id, { status: 'completed', credentials: [{ id: 'pid-sd-jwt', values: [{ age_equal_or_over: { '18': true }, iss: 'x', vct: 'urn:eudi:pid:de:1', cnf: {} }] }] });
  assert.equal(ageRun.steps[0].assertions.find((a) => a.id === 'disclosure')!.status, 'passed');
});

test('workspaces scope runs, and the same-device redirect leads back to the run', async () => {
  const { engine, backend, store } = await setup();
  const app = createApp(engine, { publicDir: path.resolve('public'), publicOrigin: 'http://localhost' });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const alice = new WalletQaClient(base);
    const workspace = await alice.createWorkspace({ tester: 'Alice', wallet: { name: 'EUDI Wallet', version: '1.4.2', platform: 'android', device: 'Pixel 8' } });
    assert.match(workspace.id, /^[A-Za-z0-9_-]{22}$/);
    const bob = new WalletQaClient(base);
    await bob.createWorkspace({ wallet: { name: 'EUDI Wallet' } });
    const run = await alice.create({ scenarioId: 'I-EAA-NOTX' });
    assert.deepEqual(run.wallet, workspace.wallet);
    const list = async (id: string) => ((await (await fetch(`${base}/v1/workspaces/${id}/runs`)).json()) as { runs: { id: string }[] }).runs.map((r) => r.id);
    assert.deepEqual(await list(workspace.id), [run.id]);
    assert.deepEqual(await list(bob.workspaceId!), []);
    assert.equal((await fetch(`${base}/v1/workspaces/does-not-exist/runs`)).status, 404);
    assert.equal((await fetch(`${base}/v1/workspaces/${'x'.repeat(22)}`)).status, 404);

    const patched = await (await fetch(`${base}/v1/workspaces/${workspace.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tester: 'Alice B.' }) })).json() as { tester: string };
    assert.equal(patched.tester, 'Alice B.');

    const sessionId = (await store.get(run.id))!.steps[0].sessionId!;
    const redirect = await fetch(`${base}/r/${sessionId}`, { redirect: 'manual' });
    assert.equal(redirect.status, 303);
    assert.equal(redirect.headers.get('location'), `/w/${workspace.id}?run=${run.id}`);
    assert.ok((await store.get(run.id))!.events.some((e) => e.type === 'redirect.received'));

    backend.sessions.set(sessionId, { status: 'completed' });
    await alice.get(run.id);
    await alice.answer(run.id, { 'card-shown': 'yes' });
    assert.equal((await alice.assertPassed(run.id)).verdict, 'passed');
    const junit = await (await fetch(`${base}/v1/workspaces/${workspace.id}/report?format=junit`)).text();
    assert.match(junit, /tests="1" failures="0"/);
    assert.match(junit, /Pixel 8/);
    assert.equal((await fetch(`${base}/v1/runs/${run.id}/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: { 'card-shown': { answer: 'maybe' } } }) })).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('expired workspaces are removed with their runs', async () => {
  const store = await new FileRunStore().init();
  const workspaces = await new FileWorkspaceStore().init();
  const engine = new Engine(store, workspaces, new FakeBackend(), { publicOrigin: 'https://qa.test', retentionMs: 1000, pollMs: 0, versions });
  const workspace = await engine.createWorkspace({ wallet: { name: 'W' } });
  const { run } = await engine.create({ workspaceId: workspace.id, scenarioId: 'I-EAA-NOTX' });
  await workspaces.put({ ...workspace, lastSeenAt: new Date(Date.now() - 5000).toISOString() });
  await engine.sweep();
  assert.equal(await workspaces.get(workspace.id), undefined);
  assert.equal(await store.get(run.id), undefined);
});
