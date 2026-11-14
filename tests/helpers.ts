import { SCENARIOS } from '../src/testing/catalog.js';
import { FileWorkspaceStore } from '../src/testing/store.js';
import type { Scenario } from '../src/testing/types.js';

/** A fixed, valid workspace ID every engine test creates its runs in. */
export const WS = 'test-workspace-0000001';

export async function testWorkspaces() {
  const store = await new FileWorkspaceStore().init();
  const now = new Date().toISOString();
  await store.put({ id: WS, tester: 'Test', wallet: { name: 'Test wallet', version: 'test-build', platform: 'ios' }, createdAt: now, lastSeenAt: now });
  return store;
}

const alias = (id: string, target: string, keepChecklist = false): Scenario => {
  const scenario = structuredClone(SCENARIOS.find((s) => s.id === target)!);
  if (!scenario) throw new Error(`Unknown catalog entry ${target}`);
  if (!keepChecklist) delete scenario.manual;
  return { ...scenario, id };
};
/**
 * The engine tests predate the checklist. They run against catalog entries
 * with the checklist removed, under their old IDs; checklist behaviour has its
 * own tests on the real catalog.
 */
export const legacyCatalog: Scenario[] = [
  alias('issue-loyalty-preauth', 'I-EAA-NOTX'),
  alias('issue-loyalty-dpop', 'I-DPOP'),
  alias('loyalty-issue-present-selective', 'P-SELECTIVE'),
  alias('reject-invalid-request-signature', 'R-SIG'),
  alias('pid-disclose-all-sd-jwt-vc', 'P-PID-PROVIDER-SDJWT'),
  alias('eaa-reject-not-available', 'R-NOT-AVAIL'),
  alias('eaa-reject-access-cert-invalid', 'R-REG-INVALID'),
  alias('pid-disclose-none-mdoc', 'R-REG-REVOKED'),
  ...[408, 429, 504].map((status) => alias(`presentation-http-${status}`, `R-HTTP-${status}`, true)),
  ...SCENARIOS,
];
