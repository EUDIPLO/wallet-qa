/**
 * Known, understood deviations of the wallet under test. A test listed here still runs and still
 * answers every checklist question from the screen; the CI result only accepts this exact outcome.
 * Remove an entry when the wallet (or the Wallet QA question) changes: a known issue that no
 * longer reproduces fails the test, so stale entries cannot hide.
 */
import type { WalletQaClient } from './wallet-qa.ts';

export interface KnownIssue {
  /** IDs of the blocking assertions that are expected to fail, and nothing else. */
  failing: string[];
  reason: string;
}

export const knownIssues: Record<string, KnownIssue> = {
  'I-PID-SDJWT': {
    failing: ['card-shown'],
    reason:
      'The EU reference wallet shows a document with its name and the issuer logo, never the credential card image (FINDINGS.md, W8).',
  },
};

type Run = Awaited<ReturnType<WalletQaClient['get']>>;

/** Waits for Wallet QA's verdict and checks it: a pass, or exactly the known issue. */
export async function assertVerdict(qa: WalletQaClient, scenarioId: string, runId: string, timeoutMs = 60_000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  let run = await qa.get(runId);
  while (!run.completed && Date.now() < deadline)
    run = await qa.get(runId, Math.max(0, Math.min(25_000, deadline - Date.now())));
  if (!run.completed) throw new Error(`No Wallet QA verdict for ${scenarioId} within ${timeoutMs} ms; pending is not a pass`);

  const known = knownIssues[scenarioId];
  const details = `${run.verdict}: ${run.reason}\n${JSON.stringify(run.assertions)}`;
  if (!known) {
    if (run.passed !== true) throw new Error(`Wallet QA ${details}`);
    return run;
  }
  if (run.passed === true)
    throw new Error(`Known issue for ${scenarioId} no longer reproduces (${known.reason}). Remove it from lib/known-issues.ts.`);
  const failing = (run.assertions as { id: string; status: string; blocking?: boolean }[])
    .filter((a) => a.status === 'failed' && a.blocking !== false)
    .map((a) => a.id)
    .sort((a, b) => a.localeCompare(b));
  const expected = [...known.failing].sort((a, b) => a.localeCompare(b));
  if (run.verdict !== 'failed' || failing.join() !== expected.join())
    throw new Error(`Wallet QA ${details}\nExpected only the known issue (${expected.join(', ')}): ${known.reason}`);
  console.log(`# ${scenarioId}: known issue reproduced (${expected.join(', ')}): ${known.reason}`);
  return run;
}
