import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { BackendRegistry, createBackendRegistry, loadBackendProfiles, type BackendProfile } from '../src/testing/backends.js';
import { Engine, liveRun } from '../src/testing/engine.js';
import { FileRunStore } from '../src/testing/store.js';
import { legacyCatalog as SCENARIOS, testWorkspaces, WS } from './helpers.js';
import { auditReport } from '../src/testing/report.js';
import type { Backend } from '../src/testing/eudiplo.js';
import type { BackendBinding, SessionEvidence } from '../src/testing/types.js';

class TenantBackend implements Backend {
  starts = 0; reads = 0; deletes: string[] = []; faultReads = 0;
  status: SessionEvidence = { status: 'active' };
  async start() { this.starts++; return { sessionId: 'same-session-id', uri: 'openid4vp://?request_uri=https%3A%2F%2Fissuer.test%2Frequest' }; }
  async session() { this.reads++; return this.status; }
  async deleteSession(id: string) { this.deletes.push(id); }
  async setStatus() {}
  async health() {}
  async requestObject() {
    this.faultReads++;
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', jwk: publicKey.export({ format: 'jwk' }) })).toString('base64url');
    const input = `${header}.${Buffer.from('{}').toString('base64url')}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  }
}
const binding = (profileId: string, identityHash = profileId): BackendBinding => ({ profileId, identityHash, instanceId: 'shared', tenantId: profileId + '-tenant', configVersion: 'v1', eudiploVersion: 'test' });
const options = { publicOrigin: 'https://qa.test', retentionMs: 3600000, pollMs: 0, versions: { catalog: '', sdk: 'test', eudiplo: 'test' }, catalog: SCENARIOS };
const workspaces = await testWorkspaces();
const input = (scenarioId: string) => ({ workspaceId: WS, scenarioId });

test('runs use separate tenant clients even when upstream session IDs collide', async () => {
  const store = await new FileRunStore().init(); const first = new TenantBackend(); const second = new TenantBackend();
  const registry = new BackendRegistry([{ binding: binding('default'), backend: first }, { binding: binding('dpop-v1'), backend: second }]);
  const engine = new Engine(store, workspaces, registry, options);
  const [a, b] = await Promise.all([engine.create(input('issue-loyalty-preauth')), engine.create(input('issue-loyalty-dpop'))]);
  assert.equal(first.starts, 1); assert.equal(second.starts, 1);
  second.status = { status: 'completed' };
  await engine.tick(b.run.id);
  await engine.tick(a.run.id);
  assert.equal((await store.get(b.run.id))!.verdict, 'passed');
  assert.equal((await store.get(a.run.id))!.verdict, null);
  assert.equal(liveRun((await store.get(b.run.id))!).currentStep.backend!.tenantId, 'dpop-v1-tenant');
  assert.equal(liveRun((await store.get(b.run.id))!).currentStep.expected, 'completed');
  assert.equal(auditReport((await store.get(b.run.id))!).run.steps[0].backend!.configVersion, 'v1');
  await engine.delete(b.run.id);
  assert.deepEqual(second.deletes, ['same-session-id']); assert.deepEqual(first.deletes, []);
  assert.ok(await store.get(a.run.id));
});

test('a multi-step run retains its backend assignments after catalog changes and restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wallet-qa-profiles-'));
  const filename = path.join(directory, 'runs.json');
  const a = new TenantBackend(); const b = new TenantBackend();
  const registry = new BackendRegistry([{ binding: binding('default'), backend: a }, { binding: binding('dpop-v1'), backend: b }]);
  const scenario = structuredClone(SCENARIOS.find(s => s.id === 'loyalty-issue-present-selective')!);
  scenario.id = 'test-multiple-tenants'; scenario.steps[1].backendProfile = 'dpop-v1'; SCENARIOS.push(scenario);
  let store = await new FileRunStore(filename).init();
  try {
    let engine = new Engine(store, workspaces, registry, options);
    const { run } = await engine.create(input(scenario.id));
    scenario.steps[1].backendProfile = 'default';
    await store.close(); store = await new FileRunStore(filename).init(); engine = new Engine(store, workspaces, registry, options);
    a.status = { status: 'completed' };
    await engine.tick(run.id);
    await engine.tick(run.id);
    assert.equal(a.starts, 1); assert.equal(b.starts, 1);
    b.status = { status: 'completed', credentials: [{ id: 'card', values: [{ member_id: `QA-${run.id}` }] }] };
    await engine.tick(run.id);
    assert.equal((await store.get(run.id))!.verdict, 'passed');
    await engine.delete(run.id);
    assert.equal(a.deletes.length, 1); assert.equal(b.deletes.length, 1);
  } finally { SCENARIOS.splice(SCENARIOS.indexOf(scenario), 1); await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('changed or missing backend bindings never fall back for polling or cleanup', async () => {
  const store = await new FileRunStore().init(); const oldBackend = new TenantBackend(); const replacement = new TenantBackend();
  const registry = new BackendRegistry([{ binding: binding('default'), backend: oldBackend }]);
  const engine = new Engine(store, workspaces, registry, options); const { run } = await engine.create(input('issue-loyalty-preauth'));
  const changed = new Engine(store, workspaces, new BackendRegistry([{ binding: binding('default', 'new-destination'), backend: replacement }]), options);
  await changed.tick(run.id); assert.equal(replacement.reads, 0);
  await changed.delete(run.id); assert.deepEqual(replacement.deletes, []); assert.ok((await store.get(run.id))!.deleted);
  await engine.sweep(); assert.equal(await store.get(run.id), undefined); assert.equal(oldBackend.deletes.length, 1);
  await assert.rejects(engine.create(input('issue-loyalty-dpop')), /not configured/);
  assert.throws(() => registry.resolve(undefined), /persisted backend/);
});

test('signature fault requests use the selected tenant backend', async () => {
  const store = await new FileRunStore().init(); const a = new TenantBackend(); const b = new TenantBackend();
  const scenario = structuredClone(SCENARIOS.find(s => s.id === 'reject-invalid-request-signature')!);
  scenario.id = 'test-second-tenant-fault'; scenario.steps[0].backendProfile = 'dpop-v1'; SCENARIOS.push(scenario);
  try {
    const engine = new Engine(store, workspaces, new BackendRegistry([{ binding: binding('default'), backend: a }, { binding: binding('dpop-v1'), backend: b }]), options);
    const { run } = await engine.create(input(scenario.id));
    assert.ok(await engine.faultRequest(run.id, run.steps[0].fault!.token, 'GET'));
    assert.equal(a.faultReads, 0); assert.equal(b.faultReads, 1);
  } finally { SCENARIOS.splice(SCENARIOS.indexOf(scenario), 1); }
});

test('backend profile loader resolves environment values without leaking secrets into bindings', async () => {
  const env = { EUDIPLO_BASE_URL: 'http://configured.test:3000' };
  const profiles = loadBackendProfiles('config/eudiplo-backends.json', env);
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].baseUrl, env.EUDIPLO_BASE_URL);
  const registry = createBackendRegistry(profiles, options.publicOrigin, options.publicOrigin);
  const saved = registry.snapshot('default');
  assert.ok(!JSON.stringify(saved).includes(profiles[0].clientSecret));
  const rotated = createBackendRegistry(profiles.map(p => ({ ...p, clientSecret: 'rotated' })), options.publicOrigin, options.publicOrigin);
  assert.doesNotThrow(() => rotated.resolve(saved));
  const changed = createBackendRegistry(profiles.map(p => ({ ...p, tenantId: 'different' })), options.publicOrigin, options.publicOrigin);
  assert.throws(() => changed.resolve(saved), /no longer available/);
  assert.equal(loadBackendProfiles('config/eudiplo-backends.json', {}).length, 2);
  const dir = await mkdtemp(path.join(tmpdir(), 'wallet-qa-profile-loader-'));
  try {
    const filename = path.join(dir, 'profiles.json');
    await writeFile(filename, JSON.stringify([{ ...profiles[0], clientSecret: '${CUSTOM_TEST_SECRET}' }]));
    assert.throws(() => loadBackendProfiles(filename, {}), /Missing backend environment/);
    assert.equal(loadBackendProfiles(filename, { CUSTOM_TEST_SECRET: 'custom-secret' })[0].clientSecret, 'custom-secret');
    await writeFile(filename, JSON.stringify([profiles[0], profiles[0]]));
    assert.throws(() => loadBackendProfiles(filename), /duplicate/);
    await writeFile(filename, JSON.stringify([{ ...profiles[0], baseUrl: 'https://user:password@example.com' }]));
    assert.throws(() => loadBackendProfiles(filename), /HTTP\(S\) origin/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('every scenario profile has a matching imported tenant and client', async () => {
  const profiles = loadBackendProfiles('config/eudiplo-backends.json', {});
  for (const scenario of SCENARIOS) for (const step of scenario.steps) {
    const profile = profiles.find(p => p.id === step.backendProfile); assert.ok(profile);
    const tenant = JSON.parse(await readFile(`eudiplo-config/${profile.tenantId}/info.json`, 'utf8')); assert.ok(tenant.spec.name);
    const client = JSON.parse(await readFile(`eudiplo-config/${profile.tenantId}/clients/test.json`, 'utf8')); assert.equal(client.spec.clientId, profile.clientId); assert.equal(client.spec.secret, profile.clientSecret);
    if (step.configId) assert.equal(JSON.parse(await readFile(`eudiplo-config/${profile.tenantId}/presentation/${step.configId}.json`, 'utf8')).spec.id, step.configId);
    for (const id of step.credentialConfigurationIds ?? []) assert.equal(JSON.parse(await readFile(`eudiplo-config/${profile.tenantId}/issuance/credentials/${id}.json`, 'utf8')).spec.id, id);
  }
  const dpop = JSON.parse(await readFile('eudiplo-config/issuer-dpop-v1/issuance/issuance.json', 'utf8'));
  assert.equal(dpop.spec.dPopRequired, true); assert.equal(dpop.spec.authorizationServers[0].requireDPoP, true);
});

test('real SDK adapters keep concurrent endpoints and bearer tokens isolated and verify tenant credentials', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { origin: string; tenant: string; path: string; method: string }[] = [];
  const profile = (id: string): BackendProfile => ({ id, instanceId: id, tenantId: id, configVersion: 'v1', eudiploVersion: 'test', baseUrl: `https://${id}.test`, publicUrl: `https://${id}.test`, clientId: id, clientSecret: `${id}-secret` });
  const registry = createBackendRegistry([profile('first'), profile('second')], options.publicOrigin, options.publicOrigin);
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); const url = new URL(request.url);
    if (url.pathname === '/api/oauth2/token') {
      const body = await request.json() as { client_id: string; client_secret: string };
      assert.equal(body.client_secret, `${body.client_id}-secret`);
      await new Promise(resolve => setTimeout(resolve, body.client_id === 'first' ? 10 : 1));
      const access_token = `header.${Buffer.from(JSON.stringify({ tenant_id: body.client_id })).toString('base64url')}.signature`;
      return Response.json({ access_token, expires_in: 3600 });
    }
    const bearer = request.headers.get('authorization')!;
    const tenant = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).tenant_id;
    assert.equal(url.hostname, `${tenant}.test`);
    requests.push({ origin: url.origin, tenant, path: url.pathname, method: request.method });
    if (url.pathname.endsWith('/offer')) {
      const body = await request.json() as Record<string, any>;
      if (url.pathname.includes('/issuer/')) {
        assert.equal(body.credentialClaims['loyalty-card'].type, 'inline');
        assert.equal(body.flow, 'pre_authorized_code');
      } else assert.equal(body.requestId, 'qa-loyalty-member');
      return Response.json({ session: 'same-session', uri: 'openid4vp://test' });
    }
    return request.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ status: 'completed' });
  };
  try {
    const [a, b] = registry.profiles().map(binding => registry.resolve(binding));
    const steps = SCENARIOS.find(s => s.id === 'loyalty-issue-present-selective')!.steps;
    await Promise.all([a.start(steps[0]), b.start(steps[0]), a.start(steps[1]), b.start(steps[1])]);
    await Promise.all([a.session('same-session'), b.session('same-session')]);
    await Promise.all([a.deleteSession('same-session'), b.deleteSession('same-session')]);
    assert.equal(requests.length, 8);
    assert.equal(requests.filter(r => r.tenant === 'first').length, 4);
    const wrong = createBackendRegistry([{ ...profile('first'), tenantId: 'wrong-tenant' }], options.publicOrigin, options.publicOrigin);
    await assert.rejects(wrong.resolve(wrong.snapshot('first')).start(steps[0]), /different tenant/);
    assert.equal(requests.length, 8);
  } finally { globalThis.fetch = originalFetch; }
});
test('authentication errors identify the resolved backend without exposing credentials', async () => {
  const profile: BackendProfile = { id: 'issuer', instanceId: 'shared', tenantId: 'issuer-tenant', configVersion: 'v1', eudiploVersion: 'test', baseUrl: 'https://internal.example.test', publicUrl: 'https://public.example.test', clientId: 'issuer-client', clientSecret: 'private-test-secret' };
  const registry = createBackendRegistry([profile], options.publicOrigin, options.publicOrigin);
  const backend = registry.resolve(registry.snapshot('issuer'));
  const step = SCENARIOS.find(s => s.id === 'loyalty-issue-present-selective')!.steps[0];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
  try {
    globalThis.fetch = async () => new Response('do not print this body', { status: 401 });
    await assert.rejects(backend.start(step), /EUDIPLO authentication failed/);
    assert.match(messages[0], /profile issuer, tenant issuer-tenant, client issuer-client, destination https:\/\/internal\.example\.test\/api\/oauth2\/token, HTTP 401/);

    globalThis.fetch = async () => { throw new TypeError('network error'); };
    await assert.rejects(backend.start(step), /network error/);
    assert.match(messages[1], /authentication request failed \(profile issuer, tenant issuer-tenant, client issuer-client, destination https:\/\/internal\.example\.test\/api\/oauth2\/token\): TypeError/);
    assert.ok(messages.every(message => !message.includes(profile.clientSecret) && !message.includes('do not print this body')));
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
