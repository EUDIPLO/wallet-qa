import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createBackendRegistry, loadBackendProfiles } from '../src/testing/backends.js';
import { SCENARIOS, scenarioForRun } from '../src/testing/catalog.js';
const origin = process.env.PUBLIC_ORIGIN ?? 'http://localhost:8787';
const backends = createBackendRegistry(loadBackendProfiles(process.env.QA_BACKENDS_FILE ?? 'config/eudiplo-backends.json'), origin, process.env.REDIRECT_URI ?? `${origin}/r/{sessionId}`);
await backends.health();
let failed = 0;
for (const scenario of SCENARIOS) {
  if (scenario.availability !== 'ready') { console.log(`SKIP ${scenario.id}: ${scenario.unavailableReason}`); continue; }
  for (const step of scenarioForRun(scenario, randomUUID(), new Date()).steps) {
    const backend = backends.resolve(backends.snapshot(step.backendProfile));
    let sessionId: string | undefined;
    try {
      const result = await backend.start(step); sessionId = result.sessionId;
      if (!sessionId || !result.uri) throw new Error('Missing session or URI');
      await backend.session(sessionId);
      console.log(`PASS start ${scenario.id}/${step.id}`);
    } catch { failed++; console.error(`FAIL start ${scenario.id}/${step.id}: verify imported configurations and EUDIPLO connectivity`); }
    finally { if (sessionId) { try { await backend.deleteSession(sessionId); } catch { failed++; console.error(`FAIL cleanup ${scenario.id}/${step.id}`); } } }
  }
}
console.log('Flow-start checks only; wallet completion is checked through /v1/runs/:id.');
process.exitCode = failed ? 1 : 0;
