import { liveRun } from './engine.js';
import { digest } from './eudiplo.js';
import type { Run, Workspace } from './types.js';
export function auditReport(run: Run) {
  const live = liveRun(run);
  return {
    schemaVersion: '2.0.0',
    run: {
      ...live,
      currentStep: run.steps[run.currentStep].definition.id,
      steps: live.steps.map(({ interaction, ...step }) => step),
    },
    wallet: run.wallet,
    attested: run.verdict === 'passed' ? !!run.attested : null,
    checklist: run.manual.map((assertion) => ({
      ...assertion,
      answer: run.answers[assertion.id] ?? null,
    })),
    versions: run.versions,
    events: run.events,
    evidence: run.steps.map((step) => ({
      stepId: step.definition.id,
      sessionId: step.sessionId,
      backendStatus: step.session?.status,
      failureCode: step.session?.failureCode,
      walletErrorCode: step.session?.walletErrorCode,
      verifiedClaimsSha256: step.session?.credentials
        ? digest(JSON.stringify(step.session.credentials))
        : undefined,
      observations: step.observations,
      fault: step.fault?.deliveredAt
        ? {
            deliveredAt: step.fault.deliveredAt,
            servedHttpStatus: step.fault.servedHttpStatus,
            originalSha256: step.fault.originalSha256,
            mutatedSha256: step.fault.mutatedSha256,
          }
        : undefined,
    })),
  };
}
const xml = (value: string) =>
  value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(
      /[<>&"']/g,
      (c) =>
        ({
          '<': '&lt;',
          '>': '&gt;',
          '&': '&amp;',
          '"': '&quot;',
          "'": '&apos;',
        })[c]!,
    );
function testcase(run: Run) {
  const failure = run.verdict === 'failed';
  const skipped = run.verdict === 'skipped';
  const error = !failure && !skipped && run.verdict !== 'passed';
  const outcome = failure
    ? `<failure message="${xml(run.reason ?? 'Failed')}"/>`
    : skipped
      ? `<skipped message="${xml(run.reason ?? 'Unsupported')}"/>`
      : error
        ? `<error type="${run.verdict ?? 'pending'}" message="${xml(run.reason ?? 'Run has not completed')}"/>`
        : '';
  const properties = `<properties><property name="attested" value="${run.verdict === 'passed' && run.attested ? 'true' : 'false'}"/><property name="runId" value="${xml(run.id)}"/></properties>`;
  return {
    failure,
    skipped,
    error,
    xml: `<testcase name="${xml(`${run.scenario.id} ${run.scenario.label}`)}" classname="${xml(run.scenario.section)}">${properties}${outcome}<system-out>${xml(JSON.stringify(auditReport(run)))}</system-out></testcase>`,
  };
}
export function junitReport(run: Run) {
  const c = testcase(run);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="Wallet QA" tests="1" failures="${Number(c.failure)}" errors="${Number(c.error)}" skipped="${Number(c.skipped)}">${c.xml}</testsuite>`;
}
export function workspaceJunitReport(workspace: Workspace, runs: Run[]) {
  const cases = runs.map(testcase);
  const count = (key: 'failure' | 'skipped' | 'error') =>
    cases.filter((c) => c[key]).length;
  const name = [workspace.wallet.name, workspace.wallet.version, workspace.wallet.platform, workspace.wallet.device]
    .filter(Boolean)
    .join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xml(`Wallet QA: ${name}`)}" tests="${cases.length}" failures="${count('failure')}" errors="${count('error')}" skipped="${count('skipped')}">${cases.map((c) => c.xml).join('')}</testsuite>`;
}
