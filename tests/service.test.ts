import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { FileRunStore, type RunStore } from '../src/testing/store.js';
import { Engine, liveRun } from '../src/testing/engine.js';
import { corruptSignature, normalizeSession, type Backend } from '../src/testing/eudiplo.js';
import type { SessionEvidence, StepDefinition } from '../src/testing/types.js';
import { createApp } from '../src/app.js';
import { junitReport, auditReport } from '../src/testing/report.js';
import { WalletQaClient } from '../src/client.js';
import { legacyCatalog, testWorkspaces, WS } from './helpers.js';
function signedRequest() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', jwk: publicKey.export({ format: 'jwk' }) })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, nonce: 'test-nonce' })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
class FakeBackend implements Backend {
  sessions = new Map<string, SessionEvidence>(); statusUpdates: { sessionId: string; status: number }[] = []; starts = 0; deletes: string[] = []; unavailable = false; startFails = false; requestFails = false;
  async start(_step: StepDefinition) {
    if (this.startFails) throw new Error('Unavailable');
    const sessionId = crypto.randomUUID(); this.starts++; this.sessions.set(sessionId, { status: 'active' });
    return { sessionId, uri: `openid4vp://?client_id=test&request_uri=${encodeURIComponent('https://eudiplo.test/request/' + sessionId)}` };
  }
  async session(id: string) { if (this.unavailable) throw new Error('Transient outage'); return structuredClone(this.sessions.get(id)!); }
  async deleteSession(id: string) { if (this.unavailable) throw new Error('Unavailable'); this.deletes.push(id); this.sessions.delete(id); }
  async setStatus(sessionId: string, status: 0 | 1 | 2) { this.statusUpdates.push({ sessionId, status }); }
  async health() { if (this.unavailable) throw new Error('Unavailable'); }
  async requestObject() { if (this.requestFails) throw new Error('Unavailable'); return signedRequest(); }
}
const wallet = { name: 'Test wallet', version: 'test-build', platform: 'ios' };
const versions = { catalog: '', sdk: '7.6.0', eudiplo: '7.6.0' };
const input = (scenarioId = 'issue-loyalty-preauth') => ({ workspaceId: WS, scenarioId });
async function setup(store?: RunStore) {
  const actual = store ?? await new FileRunStore().init(); const backend = new FakeBackend();
  const engine = new Engine(actual, await testWorkspaces(), backend, { publicOrigin: 'https://qa.test', retentionMs: 3600000, pollMs: 0, versions, catalog: legacyCatalog });
  return { store: actual, backend, engine };
}
async function completeSession(store: RunStore, backend: FakeBackend, id: string, credentials?: SessionEvidence['credentials']) {
  const run = (await store.get(id))!; backend.sessions.set(run.steps[run.currentStep].sessionId!, { status: 'completed', credentials });
}
test('backend completion determines issuance success without wallet observations', async () => {
  const { engine, backend, store } = await setup(); const { run } = await engine.create(input());
  await completeSession(store, backend, run.id); await engine.tick(run.id);
    const live = liveRun((await store.get(run.id))!); assert.equal(live.completed, true); assert.equal(live.passed, true);
});
test('multi-step issuance/presentation uses fresh sessions and validates exact run-specific claims', async () => {
  const { engine, backend, store } = await setup(); const { run } = await engine.create(input('loyalty-issue-present-selective'));
  await completeSession(store, backend, run.id);
  await engine.tick(run.id);
  assert.equal((await store.get(run.id))!.currentStep, 1);
  await engine.tick(run.id); assert.equal(backend.starts, 2);
  await completeSession(store, backend, run.id, [{ id: 'card', values: [{ member_id: `QA-${run.id}`, iss: 'issuer', vct: 'type' }] }]);
  await engine.tick(run.id);
  assert.equal((await store.get(run.id))!.verdict, 'passed');
});
for (const [label, claims] of [['over-disclosure', { member_id: 'correct', organization_name: 'Unexpected' }], ['wrong credential', { member_id: 'another-run' }]] as const) {
  test(`selective disclosure fails on ${label}`, async () => {
    const { engine, backend, store } = await setup(); const { run } = await engine.create(input('loyalty-issue-present-selective'));
    await completeSession(store, backend, run.id); await engine.tick(run.id); await engine.tick(run.id);
    await completeSession(store, backend, run.id, [{ id: 'card', values: [{ ...claims, member_id: claims.member_id === 'correct' ? `QA-${run.id}` : claims.member_id }] }]);
    await engine.tick(run.id);
    assert.equal((await store.get(run.id))!.verdict, 'failed');
  });
}
test('signature mutation preserves header/payload and rejects an already invalid baseline', () => {
  const jwt = signedRequest(); const mutated = corruptSignature(jwt);
  assert.deepEqual(mutated.jwt.split('.').slice(0, 2), jwt.split('.').slice(0, 2));
  assert.notEqual(mutated.originalSha256, mutated.mutatedSha256);
  assert.throws(() => corruptSignature(mutated.jwt), /Baseline/);
});
test('negative test requires delivered fault and matching backend rejection evidence', async () => {
  const { engine, store, backend } = await setup(); const { run } = await engine.create(input('reject-invalid-request-signature'));
  await engine.tick(run.id); assert.equal((await store.get(run.id))!.verdict, null);
  const current = (await store.get(run.id))!;
  await engine.faultRequest(run.id, current.steps[0].fault!.token, 'GET');
  await engine.tick(run.id); assert.equal((await store.get(run.id))!.verdict, null);
  backend.sessions.set(run.steps[0].sessionId!, { status: 'failed', walletErrorCode: 'invalid_request' });
  await engine.tick(run.id);
  assert.equal((await store.get(run.id))!.verdict, 'passed');
});
test('wrong rejection reason and a successful negative presentation both fail', async () => {
  for (const accepted of [true, false]) {
    const { engine, store, backend } = await setup(); const { run } = await engine.create(input('reject-invalid-request-signature'));
    await engine.faultRequest(run.id, run.steps[0].fault!.token, 'GET');
    if (accepted) await completeSession(store, backend, run.id);
    else backend.sessions.set(run.steps[0].sessionId!, { status: 'failed', walletErrorCode: 'access_denied' });
    await engine.tick(run.id);
    assert.equal((await store.get(run.id))!.verdict, 'failed');
  }
});
test('timeouts are inconclusive; transient evidence outages recover; persistent outages are errors', async () => {
  const { engine, store, backend } = await setup();
  const first = await engine.create(input()); backend.unavailable = true; await engine.tick(first.run.id);
  assert.equal((await store.get(first.run.id))!.verdict, null);
  backend.unavailable = false; await completeSession(store, backend, first.run.id);
  await engine.tick(first.run.id);
  assert.equal((await store.get(first.run.id))!.verdict, 'passed');
  for (const outage of [false, true]) {
    const { run } = await engine.create(input()); backend.unavailable = outage; await engine.tick(run.id);
    await store.update(run.id, async r => { r.deadlineAt = new Date(0).toISOString(); }); await engine.tick(run.id);
    assert.equal((await store.get(run.id))!.verdict, outage ? 'error' : 'inconclusive'); backend.unavailable = false;
  }
});
test('every create starts its own run and offer', async () => {
  const { engine, backend } = await setup();
  const runs = await Promise.all(Array.from({ length: 4 }, () => engine.create(input())));
  assert.equal(new Set(runs.map(r => r.run.id)).size, 4); assert.equal(backend.starts, 4);
});
test('positive presentations finish from backend status and migrate old pending wallet assertions', async () => {
  const { engine, backend, store } = await setup();
  const { run } = await engine.create(input('pid-disclose-all-sd-jwt-vc'));
  await store.update(run.id, async r => { r.steps[0].assertions.push({ id: 'wallet', source: 'wallet', status: 'pending', expected: 'presentation_approved' }); });
  await completeSession(store, backend, run.id); await engine.tick(run.id);
  const result = liveRun((await store.get(run.id))!);
  assert.equal(result.passed, true);
  assert.ok(result.assertions.every(a => a.source === 'server'));
});
test('negative presentation cannot pass from fetched status or a failure without a code', async () => {
  const { engine, backend, store } = await setup();
  const { run } = await engine.create(input('eaa-reject-not-available'));
  backend.sessions.set(run.steps[0].sessionId!, { status: 'fetched' }); await engine.tick(run.id);
  assert.equal((await store.get(run.id))!.verdict, null);
  backend.sessions.set(run.steps[0].sessionId!, { status: 'failed' }); await engine.tick(run.id);
  assert.equal((await store.get(run.id))!.verdict, 'inconclusive');
});
test('unsupported fixtures are skipped with no backend calls, never passed', async () => {
  const { engine, backend } = await setup(); const { run } = await engine.create(input('eaa-reject-access-cert-invalid'));
  assert.equal(run.verdict, 'skipped'); assert.equal(liveRun(run).passed, false); assert.equal(backend.starts, 0);
  assert.match(junitReport(run), /<skipped/);
});
test('audit never includes fault capabilities, raw JWTs or verified claim values', async () => {
  const { engine, store } = await setup(); const { run } = await engine.create(input('reject-invalid-request-signature'));
  const report = JSON.stringify(auditReport(run)); assert.ok(!report.includes(run.steps[0].fault!.token));
  assert.ok(!report.includes('request_uri')); assert.match(junitReport(run), /errors="1"/);
  await engine.delete(run.id); assert.equal(await store.get(run.id), undefined);
});
test('expired runs clean only their own backend sessions; cleanup failures are retried', async () => {
  const { engine, store, backend } = await setup(); const first = await engine.create(input()); const second = await engine.create(input());
  backend.unavailable = true; await engine.delete(first.run.id); assert.equal((await store.get(first.run.id))!.deleted, true);
  backend.unavailable = false; await engine.sweep(); assert.equal(await store.get(first.run.id), undefined);
  assert.ok(backend.sessions.has(second.run.steps[0].sessionId!));
});
test('local persistence survives restart and blocks a second writer', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wallet-qa-store-'));
  const file = path.join(directory, 'runs.json');
  const store = await new FileRunStore(file).init();
  try {
    const { engine } = await setup(store); const { run } = await engine.create(input());
    await assert.rejects(new FileRunStore(file).init(), /already in use/); await store.close();
    const reopened = await new FileRunStore(file).init(); assert.equal((await reopened.get(run.id))!.scenario.id, run.scenario.id); await reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('normalization rejects unknown status and removes private backend fields', () => {
  assert.throws(() => normalizeSession({ status: 'unsuccessful' }), /Unsupported/);
  const rejection = normalizeSession({ status: 'failed', errorReason: 'Wallet error: invalid_request: sensitive details' });
  assert.equal(rejection.walletErrorCode, 'invalid_request');
  assert.ok(!JSON.stringify(rejection).includes('sensitive details'));
  assert.deepEqual(normalizeSession({ status: 'completed', refresh_token: 'secret', responseEncryptionPrivateJwk: { d: 'private' } }), { status: 'completed', failureCode: undefined, walletErrorCode: undefined, credentials: undefined });
  // EUDIPLO 8.x: an issued credential shows up as a notification entry while the status stays fetched.
  assert.equal(normalizeSession({ status: 'fetched', notifications: [{ id: 'n1', credentialConfigurationId: 'loyalty-card' }] }).status, 'completed');
  assert.equal(normalizeSession({ status: 'fetched', notifications: [{ id: 'n1', event: 'credential_failure' }] }).status, 'failed');
  assert.equal(normalizeSession({ status: 'fetched', notifications: [] }).status, 'fetched');
  // EUDIPLO 8.x returns null for unset columns.
  assert.deepEqual(normalizeSession({ status: 'active', credentials: null, failureCode: null, errorReason: null, outcome: null }), { status: 'active', failureCode: undefined, walletErrorCode: undefined, credentials: undefined });
});
test('HTTP API is open, provides live results, bounded waits and immediate client assertions', async () => {
  const { engine, backend, store } = await setup();
  const app = createApp(engine, { publicDir: path.resolve('public'), publicOrigin: 'http://localhost' });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const scenarios = await fetch(`${base}/v1/scenarios`);
    assert.equal(scenarios.status, 200); assert.ok(((await scenarios.json()) as { scenarios: unknown[] }).scenarios.length > 0);
    assert.equal((await fetch(`${base}/v1/environment`)).status, 200);
    const client = new WalletQaClient(base, WS); const run = await client.create(input());
    assert.ok(!('runToken' in run));
    assert.equal((await client.get(run.id)).completed, false);
    assert.equal(((await (await fetch(`${base}/v1/workspaces/${WS}/runs`)).json()) as { runs: { id: string }[] }).runs[0].id, run.id);
    assert.equal((await fetch(`${base}/v1/runs/${run.id}?waitMs=25001`)).status, 400);
    const waiting = client.get(run.id, 1000);
    await completeSession(store, backend, run.id);
    assert.equal((await waiting).passed, true); assert.equal((await client.assertPassed(run.id)).verdict, 'passed');
    assert.equal((await fetch(`${base}/v1/runs/${run.id}/report?format=junit`)).headers.get('content-type')?.includes('xml'), true);
    const skipped = await client.create(input('pid-disclose-none-mdoc'));
    await assert.rejects(client.assertPassed(skipped.id), /skipped/);
    const failure = await client.create(input()); backend.sessions.set((await store.get(failure.id))!.steps[0].sessionId!, { status: 'failed' });
    await assert.rejects(client.assertPassed(failure.id), /failed/);
    const negative = await client.create(input('reject-invalid-request-signature'));
    const faultUrl = new URL(new URL(negative.currentStep.interaction.uri!).searchParams.get('request_uri')!);
    const faultResponse = await fetch(base + faultUrl.pathname);
    assert.equal(faultResponse.status, 200);
    assert.match(faultResponse.headers.get('content-type')!, /application\/oauth-authz-req\+jwt/);
    const awaitedJwt = await faultResponse.text();
    assert.throws(() => corruptSignature(awaitedJwt), /Baseline/);
    backend.sessions.set((await store.get(negative.id))!.steps[0].sessionId!, { status: 'failed', walletErrorCode: 'invalid_request' });
    assert.equal((await client.assertPassed(negative.id)).passed, true);
    assert.equal((await fetch(base + faultUrl.pathname)).status, 404);
    assert.equal((await fetch(`${base}/v1/runs/not-a-uuid`)).status, 404);
    backend.unavailable = true;
    assert.equal((await fetch(`${base}/health/ready`)).status, 503);
    backend.unavailable = false;
    await client.delete(run.id); await assert.rejects(client.get(run.id), /404/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('setup failures and known infrastructure failures produce errors, not wallet failures', async () => {
  const { engine, backend, store } = await setup();
  backend.startFails = true;
  const failed = await engine.create(input()); assert.equal(failed.run.verdict, 'error');
  assert.match(failed.run.reason!, /Could not prepare backend scenario: Unavailable/);
  backend.startFails = false;
  const { run } = await engine.create(input());
  backend.sessions.set(run.steps[0].sessionId!, { status: 'failed', failureCode: 'trust_list_unavailable' });
  await engine.tick(run.id); assert.equal((await store.get(run.id))!.verdict, 'error');
});
test('EUDIPLO interaction errors log run context without repeating poll failures', async () => {
  const { engine, backend } = await setup();
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
  try {
    backend.startFails = true;
    const failed = await engine.create(input());
    assert.match(messages[0], new RegExp(`EUDIPLO offer preparation failed \\(run ${failed.run.id}, step issue, profile default\\): Unavailable`));

    backend.startFails = false;
    const { run } = await engine.create(input());
    backend.unavailable = true;
    await engine.tick(run.id);
    await engine.tick(run.id);
    assert.equal(messages.length, 2);
    assert.match(messages[1], new RegExp(`EUDIPLO session retrieval failed \\(run ${run.id}, step issue, profile default\\): Transient outage`));

    await engine.delete(run.id);
    assert.match(messages[2], new RegExp(`EUDIPLO session cleanup failed \\(run ${run.id}, step issue, profile default\\): Unavailable`));

    backend.unavailable = false;
    backend.requestFails = true;
    const fault = await engine.create(input('reject-invalid-request-signature'));
    await engine.faultRequest(fault.run.id, fault.run.steps[0].fault!.token, 'GET');
    assert.match(messages[3], new RegExp(`EUDIPLO request-object retrieval failed \\(run ${fault.run.id}, step reject, profile default\\): Unavailable`));
  } finally {
    console.error = originalError;
  }
});
test('interrupted preparation fails without starting another upstream session', async () => {
  const { engine, backend, store } = await setup(); const { run } = await engine.create(input());
  await store.update(run.id, async r => { r.state = 'preparing'; r.steps[0].state = 'preparing'; r.steps[0].sessionId = undefined; r.steps[0].startedAt = new Date(Date.now() - 31000).toISOString(); });
  await engine.tick(run.id); assert.equal((await store.get(run.id))!.verdict, 'error'); assert.equal(backend.starts, 1);
});
test('finished verdicts are immutable and never accept new evidence', async () => {
  const { engine, backend, store } = await setup(); const { run } = await engine.create(input());
  await completeSession(store, backend, run.id);
  await engine.tick(run.id);
  backend.sessions.set(run.steps[0].sessionId!, { status: 'failed' }); await engine.tick(run.id);
  assert.equal((await store.get(run.id))!.verdict, 'passed');
});
// HTTP Statuses
for (const httpStatus of [429, 504, 408] as const) {
  test(`HTTP ${httpStatus} is served on retries and only the checklist can pass it`, async () => {
    const { engine, backend, store } = await setup();

    // HTTP fixtures must not fetch or modify an upstream JWT.
    backend.requestFails = true;

    const app = createApp(engine, {
      publicDir: path.resolve('public'),
      publicOrigin: 'http://localhost',
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      const { run } = await engine.create(input(`presentation-http-${httpStatus}`));
      const interaction = new URL(run.steps[0].uri!);
      const requestUri = new URL(interaction.searchParams.get('request_uri')!);
      const requestUrl = base + requestUri.pathname;

      const invalidTokenUrl = `${base}/protocol/${run.id}/wrong-token/request`;
      assert.equal((await fetch(invalidTokenUrl)).status, 404);

      for (const method of ['GET', 'GET', 'POST']) {
        const response = await fetch(requestUrl, {
          method,
          ...(method === 'POST'
            ? {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'wallet_nonce=test',
              }
            : {}),
        });

        assert.equal(response.status, httpStatus);
        const body = await response.json() as { error: { code: string } };
        assert.equal(body.error.code, `HTTP_${httpStatus}`);
      }

      await engine.tick(run.id);

      // Serving the fault is all the server can prove; the checklist decides.
      const current = (await store.get(run.id))!;
      assert.equal(current.verdict, null);
      assert.equal(current.state, 'awaiting_tester');
      assert.equal(current.steps[0].fault?.servedHttpStatus, httpStatus);
      assert.equal(current.steps[0].assertions.find(a => a.id === 'fault')?.status, 'passed');
      assert.equal(current.steps[0].assertions.find(a => a.id === 'protocol'), undefined);
      assert.equal(auditReport(current).evidence[0].fault?.servedHttpStatus, httpStatus);

      // The deadline no longer applies once only the tester can decide.
      await store.update(run.id, async saved => {
        saved.deadlineAt = new Date(Date.now() - 1).toISOString();
      });
      await engine.tick(run.id);
      assert.equal((await store.get(run.id))!.verdict, null);

      const at = new Date().toISOString();
      const done = await engine.answer(run.id, { 'error-shown': { answer: 'yes', at }, 'no-crash': { answer: 'no', at } });
      assert.equal(done.verdict, 'passed');
      assert.equal(done.attested, true);
      assert.equal((await fetch(requestUrl)).status, 404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await store.close();
    }
  });
}