import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('fixture generation preserves all tenant wrappers and DPoP policies with distinct certificate keys', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wallet-qa-tenant-fixtures-'));
  const output = path.join(directory, 'generated');
  const json = async (filename: string) => JSON.parse(await readFile(filename, 'utf8'));
  try {
    execFileSync(process.execPath, ['scripts/generate-fixtures.mjs', 'issuer.test', output], { stdio: 'pipe' });
    const root = new X509Certificate(await readFile(path.join(output, 'public/test-root.pem')));
    const keys = new Set<string>();
    for (const tenant of ['base', 'issuer-dpop-v1']) {
      for (const name of ['access', 'attestation', 'status-list', 'trust-list']) {
        const relative = `${tenant}/key-chains/${name}.json`;
        const source = await json(`eudiplo-config/${relative}`);
        const generated = await json(path.join(output, 'config', relative));
        assert.equal(generated.$schema, source.$schema);
        assert.deepEqual(generated.metadata, source.metadata);
        assert.equal(generated.spec.id, source.spec.id);
        const key = createPublicKey(createPrivateKey({ format: 'jwk', key: generated.spec.keySource.jwk }));
        const certificate = new X509Certificate(generated.spec.crt[0]);
        assert.ok(certificate.verify(root.publicKey));
        assert.equal(certificate.checkHost('issuer.test'), 'issuer.test');
        assert.deepEqual(certificate.publicKey.export({ format: 'jwk' }), key.export({ format: 'jwk' }));
        keys.add(JSON.stringify(key.export({ format: 'jwk' })));
      }
      const issuance = await json(path.join(output, 'config', tenant, 'issuance/issuance.json'));
      assert.equal(issuance.spec.authorizationServers[0].type, 'built-in');
      assert.equal(issuance.spec.authorizationServers[0].requireDPoP, tenant === 'issuer-dpop-v1');
      assert.equal(issuance.spec.dPopRequired, tenant === 'issuer-dpop-v1');
    }
    assert.equal(keys.size, 8);
    assert.throws(() => execFileSync(process.execPath, ['scripts/generate-fixtures.mjs', 'issuer.test', output], { stdio: 'pipe' }), /Output already exists/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('mounted tenant configs contain all referenced resources and no unresolved secret placeholders', async () => {
  const { readdir } = await import('node:fs/promises');
  const references: Record<string, string> = {
    keychainid: 'KeyChain', signingkeyid: 'KeyChain',
    credentialconfigid: 'CredentialConfig', credentialconfigurationid: 'CredentialConfig',
    presentationconfigid: 'PresentationConfig', webhookendpointid: 'WebhookEndpoint',
    attributeproviderid: 'AttributeProvider', trustlistid: 'TrustList',
    allowedpresentationconfigs: 'PresentationConfig', allowedissuanceconfigs: 'CredentialConfig',
  };
  for (const tenant of await readdir('eudiplo-config', { withFileTypes: true })) {
    if (!tenant.isDirectory()) continue;
    const documents: { file: string; document: any }[] = [];
    async function collect(directory: string) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(file);
        else if (entry.name.endsWith('.json')) documents.push({ file, document: JSON.parse(await readFile(file, 'utf8')) });
      }
    }
    await collect(path.join('eudiplo-config', tenant.name));
    const available = new Set(documents.map(({ document }) => {
      const kind = /\/([A-Za-z]+)ConfigFile\.schema\.json$/.exec(document.$schema)![1];
      // Schema names omit "Config" for credentials and presentations.
      return `${['Credential', 'Presentation'].includes(kind) ? kind + 'Config' : kind}/${document.spec.id ?? document.spec.clientId ?? ''}`;
    }));
    const issues: string[] = [];
    function visit(value: unknown, location: string) {
      if (typeof value === 'string' && /^\$\{/.test(value)) issues.push(`${location}: unresolved placeholder`);
      if (!value || typeof value !== 'object') return;
      for (const [field, item] of Object.entries(value)) {
        const normalized = field.toLowerCase();
        const target = normalized.endsWith('keychainid') ? 'KeyChain' : references[normalized];
        if (target) for (const id of Array.isArray(item) ? item : [item]) {
          if (typeof id === 'string' && id && !available.has(`${target}/${id}`)) issues.push(`${location}/${field}: missing ${target}/${id}`);
        }
        visit(item, `${location}/${field}`);
      }
    }
    for (const { file, document } of documents) visit(document.spec, file + '/spec');
    assert.deepEqual(issues, [], `Invalid startup bundle for ${tenant.name}`);
  }
});
