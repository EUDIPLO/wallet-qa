import {
  finish,
  record,
  type Assertion,
  type ClaimPath,
  type DisclosurePolicy,
  type ManualAnswer,
  type Run,
  type Scenario,
  type Step,
  type StepDefinition,
} from './types.js';

// Verdict rules (docs/design.md section 3):
// - A failed server assertion fails the run. Tester answers cannot override it.
// - A positive run passes when every server assertion passed and every blocking
//   checklist question was answered as expected.
// - A blocking answer that differs from the expectation fails the run.
// - When EUDIPLO has no deciding evidence (timeout, silent rejection, HTTP
//   fault) and the scenario allows it, blocking answers decide; the verdict is
//   then marked attested. Without that fallback the run is inconclusive.

const protocolClaims = new Set([
  'iss',
  'iat',
  'exp',
  'nbf',
  'cnf',
  'vct',
  'vct#integrity',
  'status',
  'sub',
  '_sd',
  '_sd_alg',
]);

export function initialAssertions(definition: StepDefinition): Assertion[] {
  const result: Assertion[] = [];
  // An HTTP fault never reaches EUDIPLO, so there is no protocol evidence to wait for.
  if (definition.httpStatus === undefined)
    result.push({
      id: 'protocol',
      source: 'server',
      status: 'pending',
      expected:
        definition.expected === 'completed'
          ? 'EUDIPLO session completed'
          : definition.expected === 'verifier_rejects'
            ? 'EUDIPLO rejected the presented credential'
            : 'EUDIPLO recorded an expected rejection error',
    });
  if (definition.kind === 'fault')
    result.push({
      id: 'fault',
      source: 'server',
      status: 'pending',
      expected:
        definition.httpStatus !== undefined
          ? `HTTP ${definition.httpStatus} returned when fetching the request`
          : 'Valid baseline signature checked and corrupted request served',
    });
  if (definition.disclosures?.length)
    result.push({
      id: 'disclosure',
      source: 'server',
      status: 'pending',
      expected: definition.disclosures
        .map((policy) => describePolicy(policy))
        .join('; '),
    });
  return result;
}

export function manualAssertions(scenario: Scenario): Assertion[] {
  return (scenario.manual ?? []).map((check) => ({
    id: check.id,
    source: 'tester',
    status: 'pending',
    expected: `${check.ask} → ${check.expect}`,
    blocking: check.blocking ?? true,
  }));
}

const pathText = (path: ClaimPath) => path.join('.');
function describePolicy(policy: DisclosurePolicy) {
  const parts = [];
  if (policy.present?.length)
    parts.push(`${policy.present.length} required claims present`);
  if (policy.equals?.length)
    parts.push(
      `${policy.equals.map((rule) => pathText(rule.path)).join(', ')} with expected values`,
    );
  if (policy.absent?.length)
    parts.push(`${policy.absent.map(pathText).join(', ')} not disclosed`);
  if (policy.allowedOnly) parts.push('no other business claims');
  return `${policy.credentialId}: ${parts.join(', ')}`;
}

function set(
  step: Step,
  id: string,
  status: Assertion['status'],
  actual: string,
) {
  const assertion = step.assertions.find((a) => a.id === id);
  if (!assertion) return;
  assertion.status = status;
  assertion.actual = actual;
}

const MISSING = Symbol('missing');
/**
 * Resolves a DCQL claim path in EUDIPLO's verified claims. SD-JWT claims are
 * nested objects; EUDIPLO flattens mDOC namespaces, so a ['namespace', 'element']
 * path falls back to the element name.
 */
export function claimAt(claims: Record<string, unknown>, path: ClaimPath) {
  let node: unknown = claims;
  for (const segment of path) {
    if (node && typeof node === 'object' && segment in (node as object))
      node = (node as Record<string, unknown>)[segment];
    else {
      node = MISSING;
      break;
    }
  }
  if (node === MISSING && path.length > 1 && path.at(-1)! in claims)
    return claims[path.at(-1)!];
  return node;
}

export function checkDisclosures(
  step: Step,
): { ok: boolean; detail: string } {
  const policies = step.definition.disclosures ?? [];
  const credentials = step.session?.credentials ?? [];
  const problems: string[] = [];
  for (const policy of policies) {
    const entries = credentials.filter((c) => c.id === policy.credentialId);
    if (entries.length !== 1) {
      problems.push(
        `${policy.credentialId}: expected one query result, got ${entries.length}`,
      );
      continue;
    }
    const values = entries[0].values;
    if (!Array.isArray(values) || values.length !== 1) {
      problems.push(`${policy.credentialId}: expected exactly one credential`);
      continue;
    }
    const claims = values[0];
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
      problems.push(`${policy.credentialId}: verified claims are missing`);
      continue;
    }
    const record = claims as Record<string, unknown>;
    const missing = (policy.present ?? []).filter(
      (path) => claimAt(record, path) === MISSING,
    );
    if (missing.length)
      problems.push(
        `${policy.credentialId}: missing ${missing.map(pathText).join(', ')}`,
      );
    const wrong = (policy.equals ?? []).filter(
      (rule) =>
        JSON.stringify(claimAt(record, rule.path)) !==
        JSON.stringify(rule.value),
    );
    if (wrong.length)
      problems.push(
        `${policy.credentialId}: missing or wrong value for ${wrong.map((r) => pathText(r.path)).join(', ')}`,
      );
    const leaked = (policy.absent ?? []).filter(
      (path) => claimAt(record, path) !== MISSING,
    );
    if (leaked.length)
      problems.push(
        `${policy.credentialId}: must not disclose ${leaked.map(pathText).join(', ')}`,
      );
    if (policy.allowedOnly) {
      const extra = Object.keys(record).filter(
        (key) => !protocolClaims.has(key) && !policy.allowedOnly!.includes(key),
      );
      if (extra.length)
        problems.push(
          `${policy.credentialId}: unexpected claims ${extra.sort().join(', ')}`,
        );
    }
  }
  return problems.length
    ? { ok: false, detail: problems.join('; ') }
    : {
        ok: true,
        detail: 'Every disclosure rule holds',
      };
}

const isLastStep = (run: Run) => run.currentStep === run.steps.length - 1;
const blockingChecks = (run: Run) =>
  run.manual.filter((a) => a.blocking !== false);

/**
 * EUDIPLO cannot decide the current step. With the attest fallback on the last
 * step, the checklist decides; otherwise the run is inconclusive.
 */
export function noEvidence(run: Run, reason: string) {
  if (run.state === 'finished') return;
  if (
    run.scenario.fallback === 'attest' &&
    isLastStep(run) &&
    blockingChecks(run).length
  ) {
    if (run.serverNoEvidence === undefined) {
      run.serverNoEvidence = reason;
      run.state = 'awaiting_tester';
      run.steps[run.currentStep].state = 'finished';
      record(run, 'tester.required', reason);
    }
    decideManual(run);
    return;
  }
  finish(run, 'inconclusive', reason);
}

/** Applies checklist answers. Called after every evaluation and every answer. */
export function decideManual(run: Run) {
  if (run.state === 'finished') return;
  const blocking = blockingChecks(run);
  const failed = blocking.find((a) => a.status === 'failed');
  if (failed) {
    finish(run, 'failed', `Tester check failed: ${failed.expected}`);
    return;
  }
  const allAnswered = blocking.every((a) => a.status === 'passed');
  if (!allAnswered) return;
  if (run.state === 'awaiting_tester') {
    const protocolEvidence =
      run.serverNoEvidence === undefined &&
      run.steps.every((s) => s.assertions.some((a) => a.id === 'protocol'));
    // Never pass on nothing: without protocol evidence a checklist is required.
    if (!protocolEvidence && !blocking.length) {
      finish(run, 'inconclusive', run.serverNoEvidence ?? 'No protocol evidence and no checklist');
      return;
    }
    run.attested =
      run.serverNoEvidence !== undefined ||
      run.steps.some((s) => !s.assertions.some((a) => a.id === 'protocol'));
    finish(
      run,
      'passed',
      run.attested
        ? `Tester-attested: ${run.serverNoEvidence ?? 'no protocol evidence for this test'}`
        : 'All server assertions and checklist answers passed',
    );
    return;
  }
  // Early attestation: the tester confirmed the wallet's behaviour before
  // EUDIPLO timed out (silent rejection). Allowed only when the wallet engaged
  // with this step, nothing failed and the wallet did not complete the step.
  const step = run.steps[run.currentStep];
  if (
    run.scenario.fallback === 'attest' &&
    blocking.length &&
    isLastStep(run) &&
    run.state === 'awaiting_wallet' &&
    step.state === 'awaiting_wallet' &&
    step.definition.expected !== 'completed' &&
    (step.fault?.deliveredAt ||
      (step.session && step.session.status !== 'active')) &&
    step.session?.status !== 'completed' &&
    !step.assertions.some((a) => a.status === 'failed') &&
    step.assertions.every((a) => a.id === 'protocol' || a.status === 'passed')
  )
    noEvidence(
      run,
      'Tester confirmed the rejection; EUDIPLO received no valid presentation',
    );
}

export function applyAnswers(
  run: Run,
  answers: Record<string, ManualAnswer>,
) {
  for (const [id, answer] of Object.entries(answers)) {
    const check = run.scenario.manual?.find((m) => m.id === id);
    const assertion = run.manual.find((a) => a.id === id);
    if (!check || !assertion) continue;
    run.answers[id] = answer;
    assertion.status = answer.answer === check.expect ? 'passed' : 'failed';
    assertion.actual = answer.note
      ? `${answer.answer} (${answer.note})`
      : answer.answer;
  }
  record(run, 'tester.answered', Object.keys(answers).join(','));
}

/** Every server assertion passed; the checklist (if any) finishes the run. */
function serverDone(run: Run) {
  run.state = 'awaiting_tester';
  if (blockingChecks(run).some((a) => a.status === 'pending'))
    record(run, 'tester.required', 'Server assertions passed');
  decideManual(run);
}

export function evaluate(run: Run) {
  if (run.state === 'finished') return;
  if (run.state === 'awaiting_tester') {
    decideManual(run);
    return;
  }
  const step = run.steps[run.currentStep];
  if (step.state !== 'awaiting_wallet') return;
  // Pending runs from older versions may still contain wallet assertions.
  step.assertions = step.assertions.filter((a) => a.source !== 'wallet');

  if (step.definition.httpStatus !== undefined) {
    if (step.fault?.deliveredAt) {
      const actual = step.fault.servedHttpStatus;
      set(
        step,
        'fault',
        actual === step.definition.httpStatus ? 'passed' : 'failed',
        `HTTP ${actual ?? 'not recorded'} served`,
      );
    }
  } else if (step.definition.kind === 'fault' && step.fault?.deliveredAt)
    set(
      step,
      'fault',
      'passed',
      'Original signature verified; mutated signature invalid; request served',
    );

  const session = step.session;
  if (session) {
    const status = session.status;
    if (
      status === 'failed' &&
      ['trust_list_unavailable', 'internal_error', 'server_error'].includes(
        session.failureCode ?? '',
      )
    ) {
      finish(
        run,
        'error',
        'Backend infrastructure could not verify the interaction',
      );
      return;
    }
    const expected = step.definition.expected;
    if (expected === 'completed') {
      if (status === 'completed') {
        set(step, 'protocol', 'passed', status);
        if (step.definition.disclosures?.length) {
          const result = checkDisclosures(step);
          set(
            step,
            'disclosure',
            result.ok ? 'passed' : 'failed',
            result.detail,
          );
        }
      } else if (status === 'failed')
        set(
          step,
          'protocol',
          'failed',
          session.walletErrorCode
            ? `Wallet error: ${session.walletErrorCode}`
            : (session.failureCode ?? status),
        );
      else if (status === 'expired') {
        noEvidence(run, 'EUDIPLO session expired before completion');
        return;
      }
    } else if (expected === 'verifier_rejects') {
      if (status === 'completed')
        set(
          step,
          'protocol',
          'failed',
          'EUDIPLO accepted a credential it should have rejected',
        );
      else if (status === 'failed') {
        if (session.walletErrorCode) {
          // The wallet refused on its own; acceptable, but only the tester can say the user was told.
          noEvidence(
            run,
            `The wallet refused before presenting (${session.walletErrorCode})`,
          );
          return;
        }
        set(
          step,
          'protocol',
          'passed',
          `EUDIPLO rejected the presentation${session.failureCode ? `: ${session.failureCode}` : ''}`,
        );
      } else if (status === 'expired') {
        noEvidence(run, 'EUDIPLO session expired without a presentation');
        return;
      }
    } else {
      if (status === 'completed')
        set(
          step,
          'protocol',
          'failed',
          'Wallet completed a request that should have been rejected',
        );
      else if (status === 'failed') {
        const code = session.walletErrorCode ?? session.failureCode;
        const expectedCodes =
          step.definition.backendErrorCodes ??
          (step.definition.rejectionReason
            ? [step.definition.rejectionReason]
            : []);
        if (!code || !expectedCodes.length) {
          noEvidence(
            run,
            'EUDIPLO reported a failure without a verifiable rejection code',
          );
          return;
        }
        set(
          step,
          'protocol',
          expectedCodes.includes(code) ? 'passed' : 'failed',
          `EUDIPLO recorded error: ${code}`,
        );
      } else if (status === 'expired') {
        noEvidence(
          run,
          'EUDIPLO session expired without an expected rejection response',
        );
        return;
      }
    }
  }

  if (step.assertions.some((a) => a.status === 'failed')) {
    finish(run, 'failed', `Assertions failed in step ${step.definition.id}`);
    return;
  }
  if (step.assertions.every((a) => a.status === 'passed')) {
    step.state = 'finished';
    record(run, 'step.passed');
    if (isLastStep(run)) serverDone(run);
    else {
      run.currentStep++;
      run.state = 'preparing';
      record(run, 'step.advance');
    }
    return;
  }
  decideManual(run);
}
