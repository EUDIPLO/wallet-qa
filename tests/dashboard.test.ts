// Runs public/app.js against a minimal fake DOM and a scripted API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync('public/app.js', 'utf8');
const html = readFileSync('public/index.html', 'utf8');
const WS = 'abcdefghijklmnopqrstuv';

type Check = { id: string; ask: string; expect: string; blocking: boolean; status: string; answer: string | null; note: string | null };
function run(verdict: string | null = null, id = 'run-1', extra: Record<string, unknown> = {}) {
  const step = { id: 'present', kind: 'presentation', state: verdict ? 'finished' : 'awaiting_wallet', instruction: 'Open it', interaction: { uri: 'openid4vp://request', crossDeviceUri: null, transactionCode: '1234' }, assertions: [] };
  const checklist: Check[] = [{ id: 'verifier-shown', ask: 'Verifier shown?', expect: 'yes', blocking: true, status: 'pending', answer: null, note: null }];
  return { id, workspaceId: WS, scenarioId: 'P-TEST', scenarioLabel: 'Test', state: verdict ? 'finished' : 'awaiting_wallet', verdict, attested: verdict === 'passed' ? false : null, completed: verdict !== null, passed: verdict === null ? null : verdict === 'passed', awaitingTester: false, noEvidence: null, reason: null, currentStep: step, steps: [step], checklist, controls: [], assertions: [], createdAt: new Date().toISOString(), ...extra };
}
type Run = ReturnType<typeof run>;

class Element {
  value = ''; disabled = false; hidden = false; textContent = ''; className = ''; type = ''; placeholder = ''; src = ''; href = ''; download = '';
  dataset: Record<string, string> = {}; children: Element[] = [];
  onclick?: () => unknown; oninput?: () => unknown; onchange?: () => unknown; onsubmit?: (event: object) => Promise<void>;
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  get firstChild() { return this.children[0]; }
  click() {}
  text(): string { return [this.textContent, ...this.children.map((c) => c.text())].join(' '); }
  find(predicate: (e: Element) => boolean): Element | undefined {
    for (const child of this.children) { if (predicate(child)) return child; const nested = child.find(predicate); if (nested) return nested; }
  }
}

async function page(options: { path?: string; search?: string; storage?: Map<string, string>; backend: { runs: Run[]; current?: Run; gone?: boolean; workspaceGone?: boolean } }) {
  const storage = options.storage ?? new Map<string, string>();
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const events: Record<string, () => void> = {};
  const requests: { url: string; method: string; body?: unknown }[] = [];
  const navigation: string[] = [];
  const document = { visibilityState: 'visible', getElementById: (id: string) => elements.get(id), createElement: () => new Element(), addEventListener: (event: string, fn: () => void) => { events[event] = fn; } };
  const { backend } = options;
  const context = vm.createContext({
    document,
    window: { addEventListener: document.addEventListener, location: { assign: (uri: string) => navigation.push(uri), search: options.search ?? '', pathname: options.path ?? `/w/${WS}`, origin: 'https://qa.test' } },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      requests.push({ url, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url === '/v1/scenarios') return Response.json({ scenarios: [
        { id: 'I-TEST', section: 'Issuance', label: 'Issue', description: 'Issue it', profile: 'oid4vci-1.0', tags: ['eaa'], prerequisites: [], availability: 'ready', steps: [] },
        { id: 'P-TEST', section: 'Presentation', label: 'Test', description: 'Present it', profile: 'oid4vp-1.0', tags: ['pid'], prerequisites: ['A PID'], availability: 'ready', steps: [] },
        { id: 'R-OFF', section: 'Rejection', label: 'Off', description: 'Not yet', profile: 'oid4vp-1.0', tags: [], prerequisites: [], availability: 'unsupported', unavailableReason: 'Fixture missing', steps: [] },
      ] });
      if (url === '/v1/environment') return Response.json({
        trust: { sha256: 'AB:CD', rootCertificateDer: 'wallet-qa-test-root.der' },
        tenants: [
          { tenantId: 'base', profileIds: ['default'], description: 'Main verifier', accessCertificate: { source: 'other', subject: 'verifier', issuer: 'Registrar CA', validTo: '2027-01-01T00:00:00.000Z' } },
          { tenantId: 'issuer-dpop-v1', profileIds: ['dpop-v1'], description: 'DPoP issuer', accessCertificate: null },
        ],
      });
      if (url === '/v1/workspaces' && method === 'POST') return Response.json({ id: WS, wallet: { name: 'W' } }, { status: 201 });
      if (url === `/v1/workspaces/${WS}`) return backend.workspaceGone ? Response.json({ error: { message: 'Workspace not found' } }, { status: 404 }) : Response.json({ id: WS, tester: 'Alice', wallet: { name: 'EUDI Wallet', version: '1.4.2', platform: 'android', device: 'Pixel 8' } });
      if (url === `/v1/workspaces/${WS}/runs`) {
        if (method === 'POST') { backend.current = run(); backend.runs.unshift(backend.current); return Response.json(backend.current, { status: 201 }); }
        return Response.json({ runs: backend.runs });
      }
      const match = /^\/v1\/runs\/([^/]+)(\/answers)?$/.exec(url);
      if (match) {
        if (backend.gone) return Response.json({ error: { message: 'Run not found' } }, { status: 404 });
        const current = backend.runs.find((r) => r.id === match[1]) ?? backend.current!;
        if (match[2]) { const passed = run('passed', current.id); backend.runs = backend.runs.map((r) => (r.id === current.id ? passed : r)); return Response.json(passed); }
        return Response.json(current);
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    },
    URL, URLSearchParams, Blob, crypto, setInterval() {}, setTimeout,
  });
  vm.runInContext(source, context);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };
  await settle();
  return { el: (id: string) => elements.get(id)!, events, requests, navigation, storage, settle };
}

test('without a workspace the setup form creates one and opens its link', async () => {
  const browser = await page({ path: '/', backend: { runs: [] } });
  assert.equal(browser.el('setup').hidden, false);
  browser.el('walletName').value = 'EUDI Wallet'; browser.el('walletVersion').value = '1.4.2'; browser.el('walletPlatform').value = 'android';
  await browser.el('workspaceForm').onsubmit!({ preventDefault() {} });
  const created = browser.requests.find((r) => r.url === '/v1/workspaces')!;
  assert.deepEqual(created.body, { wallet: { name: 'EUDI Wallet', version: '1.4.2', platform: 'android' } });
  assert.deepEqual(browser.navigation, [`/w/${WS}`]);
  assert.equal(browser.storage.get('walletqa.lastWorkspace'), WS);
});

test('an unknown workspace falls back to the setup form', async () => {
  const browser = await page({ backend: { runs: [], workspaceGone: true } });
  assert.equal(browser.el('setup').hidden, false);
  assert.match(browser.el('message').textContent, /does not exist/);
});

test('the workspace lists tests by section, starts a run and keeps the UI test contract', async () => {
  const backend = { runs: [] as Run[] };
  const browser = await page({ search: '?scenario=P-TEST', backend });
  assert.equal(browser.el('workspaceView').hidden, false);
  assert.match(browser.el('workspaceSummary').textContent, /Alice · EUDI Wallet 1\.4\.2 · android · Pixel 8/);
  const list = browser.el('testList').text();
  assert.match(list, /Issuance/); assert.match(list, /R-OFF.*unsupported/);
  assert.equal(browser.el('testLabel').textContent, 'Test');
  assert.equal(browser.el('startButton').disabled, false);
  await browser.el('startButton').onclick!(); await browser.settle();
  assert.equal(browser.storage.get(`walletqa.activeRun.${WS}`), 'run-1');
  assert.equal(browser.el('verdict').textContent, 'Status: awaiting wallet');
  assert.equal(browser.el('runId').textContent, 'Run ID: run-1');
  assert.equal(browser.el('txCode').textContent, 'Transaction code: 1234');
  assert.equal(browser.el('instruction').textContent, 'Open it');
  assert.equal(browser.el('liveRun').dataset.passed, 'pending');
  browser.el('openWallet').onclick!();
  assert.deepEqual(browser.navigation, ['openid4vp://request']);
});

test('unsupported tests cannot be started', async () => {
  const browser = await page({ search: '?scenario=R-OFF', backend: { runs: [] } });
  assert.equal(browser.el('startButton').disabled, true);
  assert.equal(browser.el('testUnavailable').hidden, false);
});

test('checklist answers are sent and the verdict is exposed to test runners', async () => {
  const backend = { runs: [run(null, 'run-1', { state: 'awaiting_tester', awaitingTester: true })] as Run[] };
  const browser = await page({ search: '?run=run-1', backend });
  assert.equal(browser.el('checklistBox').hidden, false);
  const yes = browser.el('checklist').find((e) => e.textContent === 'Yes')!;
  yes.onclick!();
  await browser.el('saveAnswers').onclick!(); await browser.settle();
  const posted = browser.requests.find((r) => r.url === '/v1/runs/run-1/answers')!;
  assert.deepEqual(posted.body, { answers: { 'verifier-shown': { answer: 'yes' } } });
  assert.equal(browser.el('verdict').textContent, 'Verdict: passed');
  assert.equal(browser.el('liveRun').dataset.completed, 'true');
  assert.equal(browser.el('liveRun').dataset.passed, 'true');
  assert.equal(browser.el('liveRun').dataset.attested, 'false');
});

test('a tester-attested pass is labelled as such', async () => {
  const backend = { runs: [run('passed', 'run-1', { attested: true })] };
  const browser = await page({ search: '?run=run-1', backend });
  assert.equal(browser.el('verdict').textContent, 'Verdict: passed (tester-attested)');
  assert.equal(browser.el('liveRun').dataset.attested, 'true');
  assert.match(browser.el('testList').text(), /passed \(attested\)/);
});

for (const verdict of ['failed', 'error', 'inconclusive', 'skipped'])
  test(`returning to the page exposes ${verdict} as a non-pass`, async () => {
    const storage = new Map([[`walletqa.activeRun.${WS}`, 'run-1']]);
    const backend = { runs: [run()] };
    const browser = await page({ storage, backend });
    backend.runs = [run(verdict)]; browser.events.pageshow(); await browser.settle();
    assert.equal(browser.el('liveRun').dataset.verdict, verdict);
    assert.equal(browser.el('liveRun').dataset.passed, 'false');
    assert.equal(browser.el('verdict').textContent, `Verdict: ${verdict}`);
  });

test('an expired saved run is cleared instead of showing an earlier success', async () => {
  const storage = new Map([[`walletqa.activeRun.${WS}`, 'run-1']]);
  const browser = await page({ storage, backend: { runs: [run('passed')], gone: true } });
  assert.equal(storage.has(`walletqa.activeRun.${WS}`), false);
  assert.equal(browser.el('liveRun').dataset.verdict, 'unavailable');
  assert.equal(browser.el('verdict').textContent, 'Verdict: none');
});

test('the page shows the instance trust setup on the setup and workspace views', async () => {
  for (const path of ['/', `/w/${WS}`]) {
    const browser = await page({ path, backend: { runs: [] } });
    assert.equal(browser.el('instanceInfo').hidden, false);
    assert.equal(browser.el('instanceSummary').textContent, 'This instance: 2 EUDIPLO tenants · wallet must trust Registrar CA');
    const tenants = browser.el('instanceTenants').text();
    assert.match(tenants, /base.*Main verifier.*issued by Registrar CA \(valid until 2027-01-01\)/);
    assert.match(tenants, /issuer-dpop-v1.*no access certificate/);
    assert.match(browser.el('instanceRoot').textContent, /SHA-256 AB:CD/);
  }
});
