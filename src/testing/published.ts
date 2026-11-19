import { randomUUID } from 'node:crypto';
import type { Run, Scenario, Verdict, Workspace } from './types.js';

/**
 * Features of the EUDIPLO wallet compatibility matrix. A test covers a feature
 * when its definition uses it; features no test covers yet are listed as such.
 */
export const FEATURES = [
  { id: 'authorization-code', label: 'OID4VCI authorization code flow' },
  { id: 'pre-authorized-code', label: 'OID4VCI pre-authorized code flow' },
  { id: 'dpop', label: 'DPoP-bound access tokens' },
  { id: 'wallet-attestation', label: 'Wallet attestation' },
  { id: 'presentation', label: 'OID4VP presentation' },
  { id: 'dc-api', label: 'OID4VP over the Digital Credentials API' },
  { id: 'annex-c', label: 'ISO 18013-7 Annex C' },
  { id: 'sd-jwt-vc', label: 'SD-JWT VC credentials' },
  { id: 'mdoc', label: 'mdoc credentials' },
] as const;
export type Feature = (typeof FEATURES)[number]['id'];

export function scenarioFeatures(scenario: Scenario): Feature[] {
  const features = new Set<Feature>();
  for (const step of scenario.steps) {
    if (step.kind === 'issuance')
      features.add(
        step.flow === 'authorization_code'
          ? 'authorization-code'
          : 'pre-authorized-code',
      );
    // Fault steps serve a broken presentation request; they test presentation handling.
    if (step.kind === 'presentation' || step.kind === 'fault')
      features.add('presentation');
  }
  const tags = new Set(scenario.tags);
  if (tags.has('dpop')) features.add('dpop');
  if (tags.has('wallet-attestation')) features.add('wallet-attestation');
  if (tags.has('dc-api')) features.add('dc-api');
  if (tags.has('annex-c')) features.add('annex-c');
  if (tags.has('dc+sd-jwt')) features.add('sd-jwt-vc');
  if (tags.has('mso_mdoc')) features.add('mdoc');
  return FEATURES.map((f) => f.id).filter((id) => features.has(id));
}

export type PublishedTest = {
  scenarioId: string;
  label: string;
  section: string;
  features: Feature[];
  verdict: Verdict;
  /** The pass rests on checklist answers instead of EUDIPLO protocol evidence. */
  attested: boolean;
  testedAt: string;
  versions: { catalog: string; eudiplo: string };
};
/**
 * What is published about a workspace. Deliberately small: no tester, notes,
 * checklist answers, claim values, session IDs or audit events.
 */
export type PublishedResult = {
  id: string;
  publishedAt: string;
  /** instance: built from this instance's own run records. self-reported: an uploaded JSON report. */
  provenance: 'instance' | 'self-reported';
  /** Origin of the instance the results were recorded on; uploads say only which instance accepted them. */
  instance: string;
  wallet: { name: string; version?: string; platform?: string; device?: string };
  tests: PublishedTest[];
};

const PUBLISHED_VERDICTS: Verdict[] = ['passed', 'failed', 'inconclusive', 'error'];
const short = (value: unknown, max = 128) =>
  typeof value === 'string' && value.trim() && value.length <= max
    ? value.trim()
    : undefined;
function walletOf(wallet: Workspace['wallet']): PublishedResult['wallet'] {
  const result: PublishedResult['wallet'] = { name: wallet.name };
  for (const key of ['version', 'platform', 'device'] as const)
    if (wallet[key]) result[key] = wallet[key];
  return result;
}
/** The latest result per test, sorted by test ID. */
function latestPerScenario(tests: PublishedTest[]) {
  const latest = new Map<string, PublishedTest>();
  for (const test of tests) {
    const current = latest.get(test.scenarioId);
    if (!current || current.testedAt < test.testedAt)
      latest.set(test.scenarioId, test);
  }
  return [...latest.values()].sort((a, b) =>
    a.scenarioId.localeCompare(b.scenarioId),
  );
}

export class PublishError extends Error {}

/** Builds the published record from this instance's runs of one workspace. */
export function publishFromRuns(
  workspace: Workspace,
  runs: Run[],
  instance: string,
): PublishedResult {
  const tests = latestPerScenario(
    runs
      .filter(
        (run) =>
          run.state === 'finished' &&
          run.verdict &&
          PUBLISHED_VERDICTS.includes(run.verdict),
      )
      .map((run) => ({
        scenarioId: run.scenario.id,
        label: run.scenario.label,
        section: run.scenario.section,
        features: scenarioFeatures(run.scenario),
        verdict: run.verdict!,
        attested: run.verdict === 'passed' && !!run.attested,
        testedAt: run.updatedAt,
        versions: { catalog: run.versions.catalog, eudiplo: run.versions.eudiplo },
      })),
  );
  if (!tests.length)
    throw new PublishError('The workspace has no finished runs to publish');
  return {
    id: randomUUID(),
    publishedAt: new Date().toISOString(),
    provenance: 'instance',
    instance,
    wallet: walletOf(workspace.wallet),
    tests,
  };
}

/**
 * Builds a self-reported record from an uploaded workspace JSON report
 * (GET /v1/workspaces/:ws/report). Only the fields of the published record are
 * read; everything else in the upload, including tester and notes, is dropped.
 * Test labels and features come from this instance's catalog, so free text
 * from an upload never reaches the page except the wallet fields.
 */
export function publishFromUpload(
  report: unknown,
  catalog: Scenario[],
  instance: string,
): PublishedResult {
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (!object(report) || !object(report.workspace) || !Array.isArray(report.runs))
    throw new PublishError('Expected a Wallet QA workspace JSON report');
  const uploadedWallet = report.workspace.wallet;
  if (!object(uploadedWallet) || !short(uploadedWallet.name))
    throw new PublishError('The report has no wallet name, or it is longer than 128 characters');
  const wallet: PublishedResult['wallet'] = { name: short(uploadedWallet.name)! };
  for (const key of ['version', 'platform', 'device'] as const) {
    const value = short(uploadedWallet[key]);
    if (value) wallet[key] = value;
  }
  const scenarios = new Map(catalog.map((s) => [s.id, s]));
  const tests: PublishedTest[] = [];
  for (const entry of report.runs.slice(0, 2000)) {
    if (!object(entry) || !object(entry.run)) continue;
    const run = entry.run;
    const scenario = scenarios.get(String(run.scenarioId));
    const verdict = run.verdict as Verdict;
    const testedAt = short(run.updatedAt, 64);
    if (
      !scenario ||
      run.completed !== true ||
      !PUBLISHED_VERDICTS.includes(verdict) ||
      !testedAt ||
      Number.isNaN(Date.parse(testedAt))
    )
      continue;
    const versions = object(entry.versions) ? entry.versions : {};
    tests.push({
      scenarioId: scenario.id,
      label: scenario.label,
      section: scenario.section,
      features: scenarioFeatures(scenario),
      verdict,
      attested: verdict === 'passed' && entry.attested === true,
      testedAt: new Date(testedAt).toISOString(),
      versions: {
        catalog: short(versions.catalog, 32) ?? 'unknown',
        eudiplo: short(versions.eudiplo, 64) ?? 'unknown',
      },
    });
  }
  const latest = latestPerScenario(tests);
  if (!latest.length)
    throw new PublishError('The report has no finished runs of known tests');
  return {
    id: randomUUID(),
    publishedAt: new Date().toISOString(),
    provenance: 'self-reported',
    instance,
    wallet,
    tests: latest,
  };
}

/**
 * The public feed: newest first, with the feature list so readers can map
 * tests to features. covered is false for features no ready test exercises.
 */
export function feed(results: PublishedResult[], catalog: Scenario[]) {
  const covered = new Set(
    catalog
      .filter((s) => s.availability === 'ready')
      .flatMap((s) => scenarioFeatures(s)),
  );
  return {
    schemaVersion: '1.0.0',
    features: FEATURES.map((f) => ({ ...f, covered: covered.has(f.id) })),
    results: [...results].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
  };
}
