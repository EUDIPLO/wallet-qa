import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkTenant } from '../src/testing/trust.js';
import type { Backend } from '../src/testing/eudiplo.js';

// Committed fixtures: the access chain is signed by the Wallet QA test root; the untrusted
// chain by another root, which here plays a certificate a deployment got from its registrar.
const testRoot = new X509Certificate(readFileSync('public/trust/test-root.pem'));
const chain = (file: string) =>
  (JSON.parse(readFileSync(`eudiplo-config/base/key-chains/${file}`, 'utf8')).spec.crt as string[]).join('\n');
const backend = (pem: string | null, fail = false) =>
  ({ async accessCertificate() { if (fail) throw new Error('EUDIPLO is unavailable'); return pem; } }) as Partial<Backend> as Backend;
const tenant = (b: Backend) => ({ tenantId: 'base', profileIds: ['default'], description: 'Main', backend: b });

test('an access certificate from the generated test root is reported as such', async () => {
  const result = await checkTenant(tenant(backend(chain('access.json'))), testRoot);
  assert.equal(result.accessCertificate?.source, 'test-root');
  assert.equal(result.accessCertificate?.issuer, 'Wallet QA Test Root CA');
  assert.equal(result.accessCertificate?.subject, 'localhost');
});

test('a certificate provided by the deployment is reported with its issuer', async () => {
  const result = await checkTenant(tenant(backend(chain('access-untrusted.json'))), testRoot);
  assert.equal(result.accessCertificate?.source, 'other');
  assert.equal(result.accessCertificate?.issuer, 'Wallet QA Untrusted Root CA');
});

test('a tenant without access key chain reports none', async () => {
  assert.equal((await checkTenant(tenant(backend(null)), testRoot)).accessCertificate, null);
});

test('failures are reported instead of thrown', async () => {
  const result = await checkTenant(tenant(backend(null, true)), testRoot);
  assert.equal(result.error, 'EUDIPLO is unavailable');
});
