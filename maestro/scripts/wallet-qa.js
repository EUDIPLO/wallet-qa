// Bridge between a Maestro flow and the Wallet QA API. Maestro runs this file with runScript;
// ACTION selects what it does, and the results land in `output.qa` for the flow:
//
//   start  creates the run for SCENARIO (and a workspace when WORKSPACE is not set)
//   step   waits until the wallet finished the current step, then moves output.qa.step on
//   finish sends checklist answers collected by the wallet adapter, waits for the verdict,
//          and fails the flow unless the test passed
//
// output.qa.step is null once no step waits for the wallet; otherwise it holds
// { id, kind, expected, uri, transactionCode } for the wallet adapter.
//
// Maestro passes -e variables and the runScript env as globals, so every optional one is read
// through `setting()`. Maestro's JavaScript has `http`, `json` and `output`, but no modules.

function setting(name, fallback) {
  // eslint-disable-next-line no-undef
  const value = typeof globalThis[name] === 'undefined' ? undefined : globalThis[name];
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

const BASE = setting('QA_URL', 'http://127.0.0.1:8787').replace(/\/+$/, '');
const POLL_MS = 8000; // per request; Maestro's HTTP client gives up on longer requests
const STEP_TIMEOUT_S = Number(setting('QA_STEP_TIMEOUT', '120'));

function base64(text) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  for (const ch of unescape(encodeURIComponent(text))) bytes.push(ch.charCodeAt(0));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
    out += i + 1 < bytes.length ? chars[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? chars[n & 63] : '=';
  }
  return out;
}

function headers() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  // A hosted instance has the page and API behind basic auth (docs/hosting.md).
  const user = setting('QA_USER');
  if (user) h.Authorization = 'Basic ' + base64(user + ':' + setting('QA_PASSWORD', ''));
  return h;
}

function call(method, path, body) {
  const options = { headers: headers() };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response =
    method === 'GET' ? http.get(BASE + path, options) : http.post(BASE + path, options);
  if (!response.ok)
    throw new Error(method + ' ' + path + ' answered ' + response.status + ': ' + response.body);
  return json(response.body);
}

function waitingStep(run) {
  const step = run.currentStep;
  if (run.completed || !step || step.state !== 'awaiting_wallet' || !step.interaction.uri)
    return null;
  return {
    id: step.id,
    kind: step.kind,
    expected: step.expected,
    uri: step.interaction.uri,
    transactionCode: step.interaction.transactionCode,
  };
}

function remember(run, extra) {
  const previous = output.qa ?? {};
  output.qa = Object.assign({}, previous, extra, {
    runId: run.id,
    workspaceId: run.workspaceId,
    state: run.state,
    verdict: run.verdict,
    step: waitingStep(run),
    answers: previous.answers ?? {},
  });
  console.log(
    '[wallet-qa] ' + run.scenarioId + ' run ' + run.id + ': ' + run.state +
      (output.qa.step ? ', waiting for ' + output.qa.step.id : '') +
      (run.verdict ? ', verdict ' + run.verdict : ''),
  );
}

function poll(runId, until, timeoutSeconds) {
  const end = Date.now() + timeoutSeconds * 1000;
  let run = call('GET', '/v1/runs/' + runId + '?waitMs=' + POLL_MS);
  while (!until(run) && Date.now() < end)
    run = call('GET', '/v1/runs/' + runId + '?waitMs=' + POLL_MS);
  return run;
}

function start() {
  const scenario = setting('SCENARIO');
  if (!scenario) throw new Error('Set SCENARIO, e.g. -e SCENARIO=P-PID-ALL-SDJWT');
  let workspace = setting('WORKSPACE');
  if (!workspace) {
    workspace = call('POST', '/v1/workspaces', {
      tester: setting('TESTER', 'maestro'),
      wallet: {
        name: setting('WALLET_NAME', setting('WALLET_APP_ID', 'unknown wallet')),
        version: setting('WALLET_VERSION'),
        platform: maestro.platform,
      },
    }).id;
  }
  const run = call('POST', '/v1/workspaces/' + workspace + '/runs', {
    scenarioId: scenario,
    timeoutSeconds: Number(setting('QA_RUN_TIMEOUT', '600')),
  });
  // A fresh run may still be preparing its EUDIPLO session.
  remember(poll(run.id, (r) => r.state !== 'preparing', 30), { answers: {} });
}

function step() {
  const current = output.qa.step;
  // A refusal may be silent: the wallet sends nothing, and EUDIPLO only sees that the request
  // was fetched. Then the adapter's answers decide (finish), so wait less and do not fail.
  const refusal = current.expected !== 'completed';
  const run = poll(
    output.qa.runId,
    (r) => r.completed || r.awaitingTester || !waitingStep(r) || waitingStep(r).id !== current.id,
    refusal ? Math.min(STEP_TIMEOUT_S, 20) : STEP_TIMEOUT_S,
  );
  const next = waitingStep(run);
  if (next && next.id === current.id && refusal) {
    console.log('[wallet-qa] no error response from the wallet; the checklist decides');
    remember(run);
    output.qa.step = null;
    return;
  }
  if (next && next.id === current.id)
    throw new Error(
      'Step ' + current.id + ' still waits for the wallet after ' + STEP_TIMEOUT_S +
        's (EUDIPLO status: ' + (run.currentStep.backendStatus ?? 'none') + ')',
    );
  remember(run);
}

function finish() {
  let run = call('GET', '/v1/runs/' + output.qa.runId);
  // Adapters answer what they can see; send only the questions this test asks.
  const asked = new Set(run.checklist.map((c) => c.id));
  const answers = {};
  for (const [id, answer] of Object.entries(output.qa.answers ?? {}))
    if (asked.has(id))
      answers[id] = { answer: answer, note: 'Answered by Maestro from the wallet screen' };
  if (Object.keys(answers).length > 0 && !run.completed)
    run = call('POST', '/v1/runs/' + output.qa.runId + '/answers', { answers: answers });
  run = poll(output.qa.runId, (r) => r.completed, 60);
  remember(run);
  const report = BASE + '/w/' + run.workspaceId + '?run=' + run.id;
  if (run.verdict !== 'passed') {
    const open = run.checklist
      .filter((c) => c.blocking && c.status === 'pending')
      .map((c) => c.id);
    let why = run.verdict ?? run.state;
    if (run.reason) why += ' (' + run.reason + ')';
    if (!run.completed && run.awaitingTester && open.length)
      why += '; a tester still has to answer: ' + open.join(', ');
    else if (!run.completed)
      why += '; the wallet did not finish step ' + run.currentStep.id +
        ' (EUDIPLO status: ' + (run.currentStep.backendStatus ?? 'none') + ')';
    throw new Error(run.scenarioId + ': ' + why + '. ' + report);
  }
  console.log('[wallet-qa] ' + run.scenarioId + ' passed' + (run.attested ? ' (tester-attested)' : '') + ': ' + report);
}

const action = setting('ACTION');
if (action === 'start') start();
else if (action === 'step') step();
else if (action === 'finish') finish();
else throw new Error('Unknown ACTION ' + action);
