// Wallet QA page. Two views: setup (no workspace) and the workspace at /w/<id>.
// Visible texts such as "Verdict: passed", "Run ID: …" and "Transaction code: …"
// and the data-* attributes on #liveRun are the contract UI test runners
// (XCUITest, Espresso, Maestro) match on. Keep them stable.
const el = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search ?? '');
const pathMatch = /^\/w\/([A-Za-z0-9_-]{22})\/?$/.exec(window.location.pathname ?? '');
const workspaceId = pathMatch?.[1];
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* Page state still works. */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* Nothing stored. */ } },
};
const lastWorkspaceKey = 'walletqa.lastWorkspace';
const activeRunKey = `walletqa.activeRun.${workspaceId ?? 'none'}`;

let workspace; let scenarios = []; let selectedScenario; let runs = [];
let activeRunId; let selectedRun; let walletUri; let busy = false;
const draftAnswers = {};

const message = (value) => { el('message').textContent = value; };
async function api(route, options = {}) {
  const response = await fetch(`/v1${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) { const error = new Error(data?.error?.message ?? 'Request failed'); error.status = response.status; throw error; }
  return data;
}
const ws = () => encodeURIComponent(workspaceId);
const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };

// ------------------------------------------------------------------ setup view
function walletFromForm() {
  const wallet = { name: el('walletName').value.trim() };
  for (const [key, id] of [['version', 'walletVersion'], ['platform', 'walletPlatform'], ['device', 'walletDevice']]) {
    const value = el(id).value.trim(); if (value) wallet[key] = value;
  }
  return wallet;
}
function showSetup(editing) {
  el('setup').hidden = false; el('workspaceView').hidden = true;
  el('createWorkspace').textContent = editing ? 'Save' : 'Create workspace';
  el('cancelEdit').hidden = !editing; el('joinExisting').hidden = !!editing; el('uploadReport').hidden = !!editing;
  const last = store.get(lastWorkspaceKey);
  el('lastWorkspace').hidden = editing || !last;
}
el('workspaceForm').onsubmit = async (event) => {
  event.preventDefault();
  const body = { tester: el('tester').value.trim() || undefined, wallet: walletFromForm() };
  try {
    if (workspace) {
      workspace = await api(`/workspaces/${ws()}`, { method: 'PATCH', body: JSON.stringify(body) });
      el('setup').hidden = true; el('workspaceView').hidden = false; renderWorkspace();
    } else {
      const created = await api('/workspaces', { method: 'POST', body: JSON.stringify(body) });
      store.set(lastWorkspaceKey, created.id);
      window.location.assign(`/w/${created.id}`);
    }
  } catch (error) { message(error.message); }
};
el('cancelEdit').onclick = () => { el('setup').hidden = true; el('workspaceView').hidden = false; };
el('joinButton').onclick = () => {
  const match = /([A-Za-z0-9_-]{22})\/?$/.exec(el('joinInput').value.trim());
  if (!match) { message('That is not a workspace link or ID.'); return; }
  window.location.assign(`/w/${match[1]}`);
};
el('resumeWorkspace').onclick = () => { const last = store.get(lastWorkspaceKey); if (last) window.location.assign(`/w/${last}`); };

// -------------------------------------------------------------- workspace view
function renderWorkspace() {
  const wallet = workspace.wallet;
  el('workspaceBar').hidden = false;
  el('workspaceSummary').textContent = [workspace.tester, [wallet.name, wallet.version].filter(Boolean).join(' '), wallet.platform, wallet.device].filter(Boolean).join(' · ');
}
el('editWorkspace').onclick = () => {
  el('tester').value = workspace.tester ?? ''; el('walletName').value = workspace.wallet.name;
  el('walletVersion').value = workspace.wallet.version ?? ''; el('walletPlatform').value = workspace.wallet.platform ?? ''; el('walletDevice').value = workspace.wallet.device ?? '';
  showSetup(true);
};
el('joinToggle').onclick = () => {
  const link = `${window.location.origin}/w/${workspaceId}`;
  el('joinLink').textContent = link;
  el('joinQr').src = `/api/qr-code?value=${encodeURIComponent(link)}`;
  el('joinPanel').hidden = !el('joinPanel').hidden;
};
el('joinClose').onclick = () => { el('joinPanel').hidden = true; };

/** The latest run of a scenario in this workspace decides its status in the list. */
function latestRun(scenarioId) { return runs.find((run) => run.scenarioId === scenarioId); }
function statusText(run) {
  if (!run) return 'not run';
  if (!run.completed) return run.awaitingTester ? 'answer checklist' : 'running';
  return run.verdict === 'passed' && run.attested ? 'passed (attested)' : run.verdict;
}
function renderList() {
  const query = el('search').value.trim().toLowerCase();
  const tag = el('tagFilter').value;
  const children = [];
  const sections = [...new Set(scenarios.map((s) => s.section))];
  let done = 0;
  for (const scenario of scenarios) if (latestRun(scenario.id)?.completed) done++;
  el('progress').textContent = `${done} of ${scenarios.filter((s) => s.availability === 'ready').length} run`;
  for (const section of sections) {
    const items = scenarios.filter((s) => s.section === section
      && (!tag || s.tags.includes(tag))
      && (!query || `${s.id} ${s.label} ${s.tags.join(' ')}`.toLowerCase().includes(query)));
    if (!items.length) continue;
    children.push(node('h3', section));
    for (const scenario of items) {
      const run = latestRun(scenario.id);
      const row = node('button', undefined, `test-row${scenario.id === selectedScenario?.id ? ' selected' : ''}${scenario.availability !== 'ready' ? ' unsupported' : ''}`);
      row.type = 'button';
      const status = scenario.availability !== 'ready' ? 'unsupported' : statusText(run);
      row.append(node('span', scenario.id, 'test-id'), node('span', scenario.label, 'test-label'), node('span', status, `status ${(run?.verdict ?? status).replace(/[^a-z]/g, '')}`));
      row.onclick = () => selectScenario(scenario);
      children.push(row);
    }
  }
  el('testList').replaceChildren(...children);
}
function selectScenario(scenario) {
  selectedScenario = scenario;
  el('testId').textContent = `${scenario.id} · ${scenario.profile} · ${scenario.tags.join(', ')}`;
  el('testLabel').textContent = scenario.label;
  el('testDescription').textContent = scenario.description;
  el('testPrerequisites').replaceChildren(...scenario.prerequisites.map((p) => node('li', p)));
  el('testRequires').textContent = scenario.requires?.length ? `Run first: ${scenario.requires.join(', ')}` : '';
  el('testUnavailable').hidden = scenario.availability === 'ready';
  el('testUnavailable').textContent = scenario.unavailableReason ?? '';
  el('startButton').disabled = scenario.availability !== 'ready';
  renderList();
}
el('search').oninput = renderList;
el('tagFilter').onchange = renderList;

el('startButton').onclick = async () => {
  if (!selectedScenario) return;
  el('startButton').disabled = true;
  const body = { scenarioId: selectedScenario.id };
  const timeoutSeconds = Number(params.get('timeoutSeconds'));
  if (Number.isInteger(timeoutSeconds) && timeoutSeconds > 0) body.timeoutSeconds = timeoutSeconds;
  try { selectRun(await api(`/workspaces/${ws()}/runs`, { method: 'POST', body: JSON.stringify(body) })); await loadRuns(); }
  catch (error) { message(error.message); }
  finally { el('startButton').disabled = selectedScenario?.availability !== 'ready'; }
};

// -------------------------------------------------------------------- live run
function clearRun(verdict) {
  activeRunId = undefined; selectedRun = undefined; walletUri = undefined;
  store.remove(activeRunKey);
  Object.assign(el('liveRun').dataset, { runId: '', completed: 'false', passed: 'pending', verdict, attested: 'false' });
  el('verdict').textContent = 'Verdict: none'; el('verdict').className = 'badge';
  for (const id of ['scenarioId', 'runId', 'reason', 'step', 'instruction']) el(id).textContent = '';
  el('interaction').hidden = true; el('checklistBox').hidden = true; el('controls').replaceChildren();
  el('assertions').replaceChildren(); el('audit').disabled = true; el('cancelRun').disabled = true;
}
function renderChecklist(run) {
  el('checklistBox').hidden = !run.checklist.length;
  const editable = !run.completed;
  el('saveAnswers').disabled = !editable;
  el('checklist').replaceChildren(...run.checklist.map((item) => {
    const box = node('div', undefined, `check ${item.status}`);
    box.append(node('p', `${item.ask}${item.blocking ? '' : ' (not blocking)'}`, 'ask'));
    const current = draftAnswers[run.id]?.[item.id]?.answer ?? item.answer;
    const buttons = node('div', undefined, 'answers');
    for (const value of ['yes', 'no']) {
      const button = node('button', value === 'yes' ? 'Yes' : 'No', current === value ? 'chosen' : 'secondary');
      button.type = 'button'; button.disabled = !editable;
      button.onclick = () => {
        draftAnswers[run.id] = { ...draftAnswers[run.id], [item.id]: { ...draftAnswers[run.id]?.[item.id], answer: value } };
        renderChecklist(run);
      };
      buttons.append(button);
    }
    const note = node('input'); note.placeholder = 'Note (optional)'; note.disabled = !editable;
    note.value = draftAnswers[run.id]?.[item.id]?.note ?? item.note ?? '';
    note.oninput = () => { draftAnswers[run.id] = { ...draftAnswers[run.id], [item.id]: { answer: current, ...draftAnswers[run.id]?.[item.id], note: note.value } }; };
    box.append(buttons, note);
    if (item.answer) box.append(node('small', item.status === 'passed' ? 'As expected' : 'Not as expected', 'muted'));
    return box;
  }));
}
function renderControls(run) {
  el('controls').replaceChildren(...run.controls.map((control) => {
    const button = node('button', control.usedAt ? `${control.label} (done)` : control.label, 'secondary');
    button.type = 'button'; button.disabled = !control.available;
    button.onclick = async () => {
      button.disabled = true;
      try { render(await api(`/runs/${encodeURIComponent(run.id)}/controls/${encodeURIComponent(control.id)}`, { method: 'POST' })); message(`${control.label}: done.`); }
      catch (error) { message(error.message); button.disabled = false; }
    };
    return button;
  }));
}
function render(run) {
  selectedRun = run;
  Object.assign(el('liveRun').dataset, { runId: run.id, completed: String(run.completed), passed: run.passed === null ? 'pending' : String(run.passed), verdict: run.verdict ?? 'pending', attested: String(!!run.attested), sync: 'fresh' });
  el('verdict').textContent = run.completed
    ? `Verdict: ${run.verdict}${run.attested ? ' (tester-attested)' : ''}`
    : `Status: ${run.state.replaceAll('_', ' ')}`;
  el('verdict').className = `badge ${run.verdict ?? ''}`;
  el('scenarioId').textContent = `Scenario: ${run.scenarioId} · ${run.scenarioLabel}`;
  el('runId').textContent = `Run ID: ${run.id}`;
  el('reason').textContent = run.reason
    ?? (run.awaitingTester ? (run.noEvidence ? `${run.noEvidence}. Answer the checklist to finish the run.` : 'The server checks passed. Answer the checklist to finish the run.')
      : 'Waiting for the wallet. The result updates automatically.');
  const step = run.currentStep;
  el('step').textContent = `Step ${step.id}: ${step.state.replaceAll('_', ' ')}`;
  el('instruction').textContent = !run.completed && step.state === 'awaiting_wallet' ? step.instruction ?? '' : '';
  const uri = step.interaction.uri;
  walletUri = undefined; el('openWallet').disabled = true;
  el('interaction').hidden = !uri || run.completed || step.state !== 'awaiting_wallet';
  if (uri) {
    el('uri').value = uri;
    // Only recognized wallet handoff schemes can be navigated from the UI.
    const scheme = new URL(uri).protocol;
    if (['openid4vp:', 'openid-credential-offer:', 'haip:', 'eudi-openid4vp:', 'https:'].includes(scheme) && !run.completed) { walletUri = uri; el('openWallet').disabled = false; }
    el('qr').src = `/api/qr-code?value=${encodeURIComponent(step.interaction.crossDeviceUri ?? uri)}`;
  }
  el('txCode').textContent = step.interaction.transactionCode ? `Transaction code: ${step.interaction.transactionCode}` : '';
  renderControls(run);
  renderChecklist(run);
  el('assertions').replaceChildren(...run.assertions.map((assertion) => {
    const row = node('tr');
    for (const value of [`${assertion.stepId ?? 'checklist'}: ${assertion.id}`, assertion.source, assertion.status]) row.append(node('td', value));
    row.firstChild.append(node('small', assertion.actual ?? assertion.expected));
    return row;
  }));
  el('audit').disabled = false; el('cancelRun').disabled = run.completed;
}
function selectRun(run) {
  activeRunId = run.id;
  store.set(activeRunKey, run.id);
  render(run);
}
async function refreshActiveRun() {
  if (!activeRunId || busy) return;
  const id = activeRunId;
  busy = true; el('liveRun').dataset.sync = 'refreshing';
  try {
    const run = await api(`/runs/${encodeURIComponent(id)}`);
    // An older in-flight poll must not replace a newly selected run.
    if (activeRunId !== id) return;
    render(run);
  } catch (error) {
    if (activeRunId !== id) return;
    el('liveRun').dataset.sync = 'error';
    if (error.status === 404 || error.status === 410) { clearRun('unavailable'); message('The saved run has expired or was deleted.'); }
    else message(error.message);
  } finally { busy = false; }
}
el('saveAnswers').onclick = async () => {
  if (!selectedRun) return;
  const answers = Object.fromEntries(Object.entries(draftAnswers[selectedRun.id] ?? {}).filter(([, value]) => value.answer));
  if (!Object.keys(answers).length) { message('Choose Yes or No first.'); return; }
  try {
    const run = await api(`/runs/${encodeURIComponent(selectedRun.id)}/answers`, { method: 'POST', body: JSON.stringify({ answers }) });
    delete draftAnswers[selectedRun.id]; render(run); await loadRuns(); message('Answers saved.');
  } catch (error) { message(error.message); }
};
el('openWallet').onclick = () => {
  if (!walletUri || !selectedRun || selectedRun.completed) return;
  // selectRun has already persisted the ID before this explicit user gesture.
  window.location.assign(walletUri);
};
el('audit').onclick = async () => {
  try { download(`wallet-qa-${selectedRun.id}.json`, JSON.stringify(await api(`/runs/${selectedRun.id}/report`), null, 2), 'application/json'); }
  catch (error) { message(error.message); }
};
el('cancelRun').onclick = async () => {
  if (!selectedRun) return;
  try { await api(`/runs/${encodeURIComponent(selectedRun.id)}`, { method: 'DELETE' }); clearRun('cancelled'); await loadRuns(); }
  catch (error) { message(error.message); }
};
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
el('reportJunit').onclick = async () => {
  const response = await fetch(`/v1/workspaces/${ws()}/report?format=junit`);
  download(`wallet-qa-${workspaceId}.xml`, await response.text(), 'application/xml');
};
el('reportJson').onclick = async () => {
  download(`wallet-qa-${workspaceId}.json`, JSON.stringify(await api(`/workspaces/${ws()}/report`), null, 2), 'application/json');
};
const publishWarning = 'Published results are public and stay until an operator removes them. Publish now?';
el('publishButton').onclick = async () => {
  if (!window.confirm(publishWarning)) return;
  try {
    const result = await api(`/workspaces/${ws()}/publish`, { method: 'POST', body: '{}' });
    message(`Published ${result.tests.length} test result${result.tests.length === 1 ? '' : 's'} to /results.`);
  } catch (error) { message(`Could not publish: ${error.message}`); }
};
el('uploadButton').onclick = async () => {
  const file = el('uploadFile').files?.[0];
  if (!file) { message('Choose a workspace JSON report first.'); return; }
  if (!window.confirm(publishWarning)) return;
  try {
    const result = await api('/uploads', { method: 'POST', body: await file.text() });
    message(`Published ${result.tests.length} self-reported test result${result.tests.length === 1 ? '' : 's'} to /results.`);
  } catch (error) { message(`Could not publish: ${error.status === 400 && error.message === 'Invalid JSON body' ? 'the file is not JSON' : error.message}`); }
};

// ----------------------------------------------------------------- run list
async function loadRuns() {
  const previous = new Set(runs.map((run) => run.id));
  runs = (await api(`/workspaces/${ws()}/runs`)).runs;
  // A run started on another device of this workspace takes over the live panel,
  // so the phone shows "Open wallet" for a run started on the laptop.
  const fresh = runs.find((run) => !previous.has(run.id) && !run.completed && run.id !== activeRunId);
  if (fresh && previous.size) selectRun(fresh);
  el('runs').replaceChildren(...runs.map((run) => {
    const item = node('div', undefined, 'run');
    item.append(node('p', `${run.scenarioId} · ${statusText(run)} · ${new Date(run.createdAt).toLocaleString()}`));
    const button = node('button', 'View', 'secondary'); button.type = 'button';
    button.onclick = () => { selectRun(run); void refreshActiveRun(); };
    item.append(button); return item;
  }));
  renderList();
}

// --------------------------------------------------------------- instance trust
const certificateText = (tenant) => {
  const cert = tenant.accessCertificate;
  if (tenant.error) return `trust check failed: ${tenant.error}`;
  if (!cert) return 'no access certificate (issuer only)';
  const until = `valid until ${cert.validTo.slice(0, 10)}`;
  return cert.source === 'test-root'
    ? `access certificate from the Wallet QA test root (${until})`
    : `access certificate issued by ${cert.issuer} (${until})`;
};
function renderInstance(environment) {
  const tenants = environment.tenants ?? [];
  const issuers = [...new Set(tenants.map((t) => t.accessCertificate).filter(Boolean).map((c) => (c.source === 'test-root' ? 'the Wallet QA test root' : c.issuer)))];
  el('instanceSummary').textContent = `This instance: ${tenants.length} EUDIPLO tenant${tenants.length === 1 ? '' : 's'}` + (issuers.length ? ` · wallet must trust ${issuers.join(' and ')}` : '');
  el('instanceTenants').replaceChildren(...tenants.map((tenant) => {
    const item = node('li');
    item.append(node('strong', tenant.tenantId), node('span', ` — ${tenant.description ?? tenant.profileIds.join(', ')}`), node('br'), node('span', certificateText(tenant), tenant.error ? 'warning' : 'muted'));
    return item;
  }));
  const root = environment.trust;
  el('instanceRoot').textContent = root ? `Wallet QA test root SHA-256 ${root.sha256} — /trust/${root.rootCertificateDer ?? 'test-root.pem'}` : '';
  el('instanceInfo').hidden = false;
}
async function loadInstance() {
  try { renderInstance(await api('/environment')); } catch { /* The page works without it. */ }
}

// ------------------------------------------------------------------- startup
async function init() {
  void loadInstance();
  if (!workspaceId) { showSetup(false); message(''); return; }
  try {
    [workspace, { scenarios }] = await Promise.all([api(`/workspaces/${ws()}`), api('/scenarios')]);
  } catch (error) {
    message(error.status === 404 ? 'This workspace does not exist or has expired. Create a new one.' : `Could not load: ${error.message}`);
    store.remove(lastWorkspaceKey);
    showSetup(false); return;
  }
  store.set(lastWorkspaceKey, workspaceId);
  el('workspaceView').hidden = false; renderWorkspace();
  const tags = [...new Set(scenarios.flatMap((s) => s.tags))].sort();
  el('tagFilter').replaceChildren(node('option', 'All tags'), ...tags.map((tag) => { const option = node('option', tag); option.value = tag; return option; }));
  el('tagFilter').firstChild.value = '';
  await loadRuns();
  // Query parameters let a UI test open the page with its test preselected.
  const preset = scenarios.find((s) => s.id === params.get('scenario')) ?? scenarios.find((s) => s.availability === 'ready');
  if (preset) selectScenario(preset);
  activeRunId = params.get('run') ?? store.get(activeRunKey) ?? undefined;
  if (activeRunId) await refreshActiveRun();
  message('');
}
setInterval(() => {
  if (!workspaceId || document.visibilityState === 'hidden') return;
  if (!selectedRun || !selectedRun.completed) void refreshActiveRun();
}, 1000);
setInterval(() => { if (workspaceId && workspace && document.visibilityState !== 'hidden') void loadRuns().catch(() => {}); }, 3000);
window.addEventListener('pageshow', () => { if (workspaceId) void refreshActiveRun(); });
window.addEventListener('focus', () => { if (workspaceId) void refreshActiveRun(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && workspaceId) void refreshActiveRun(); });
void init();
