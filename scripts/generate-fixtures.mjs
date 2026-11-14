// Generates the test trust material for every tenant under the config root:
// a fresh root CA, the leaf key chains each tenant uses, and the deliberately
// broken access certificate R-ACCESS-UNTRUSTED selects with accessKeyChainId.
//
//   pnpm fixtures:generate <eudiplo-host> [output] [config-root]
//
// Output: config/ (the whole tenant config with the new key chains, to update eudiplo-config/),
// overlay/ (only the key chains, the start of a deployment's overlay, see docs/hosting.md),
// public/ (served as /trust) and ca/ (private root keys).
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';

const [host, output = 'fixtures', source = 'eudiplo-config'] = process.argv.slice(2);
if (!host || !/^[a-zA-Z0-9.-]+$/.test(host))
  throw new Error('Usage: pnpm fixtures:generate <eudiplo-hostname> [new-output-directory] [tenant-config-root]');
if (existsSync(output)) throw new Error('Output already exists. Use a new directory to avoid replacing trust material.');

const root = path.resolve(output);
const configRoot = path.join(root, 'config');
const tenants = readdirSync(source, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(source, entry.name, 'info.json')))
  .map((entry) => entry.name);
if (!tenants.length) throw new Error('Expected a config root containing tenant directories with info.json');
const ca = path.join(root, 'ca');
const pub = path.join(root, 'public');
mkdirSync(ca, { recursive: true, mode: 0o700 });
mkdirSync(pub, { recursive: true });
cpSync(source, configRoot, { recursive: true });

const openssl = (...args) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
const san = `${isIP(host) ? 'IP' : 'DNS'}:${host}`;

function selfSignedRoot(name, subject) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const key = path.join(ca, `${name}.key`);
  const cert = path.join(ca, `${name}.pem`);
  writeFileSync(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  openssl('req', '-new', '-x509', '-sha256', '-key', key, '-subj', `/CN=${subject}`, '-days', '3650', '-out', cert,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  return { key, cert };
}

// The trusted root (published) and an untrusted one (its key stays in fixtures/ca, never published).
const trusted = selfSignedRoot('root', 'Wallet QA Test Root CA');
const untrusted = selfSignedRoot('untrusted-root', 'Wallet QA Untrusted Root CA');
writeFileSync(path.join(pub, 'test-root.pem'), readFileSync(trusted.cert));

function leaf(dir, name, { issuer }) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyPath = path.join(dir, `${name}.key`);
  const csrPath = path.join(dir, `${name}.csr`);
  const certPath = path.join(dir, `${name}.pem`);
  const ext = path.join(dir, `${name}.ext`);
  writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  openssl('req', '-new', '-sha256', '-key', keyPath, '-subj', `/CN=${host}`, '-out', csrPath);
  writeFileSync(ext, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectAltName=${san}\n`);
  openssl('x509', '-req', '-sha256', '-in', csrPath, '-CA', issuer.cert, '-CAkey', issuer.key, '-CAcreateserial', '-days', '365', '-extfile', ext, '-out', certPath);
  return { pair, certPath };
}

function keyChainDocument(template, id, usageType, description, pair, certPath, issuerCert) {
  return {
    $schema: template.$schema,
    metadata: { generation: 1 },
    spec: {
      id, description, usageType, kmsProvider: 'db',
      keySource: { type: 'private-jwk', jwk: { ...pair.privateKey.export({ format: 'jwk' }), alg: 'ES256', kid: `${id}-active` } },
      crt: [readFileSync(certPath, 'utf8'), readFileSync(issuerCert, 'utf8')],
      rotationPolicy: { enabled: false },
    },
  };
}

// A broken access certificate, selected per presentation config. EUDIPLO 8.1 refuses to sign with an
// expired or revoked access certificate, so only the untrusted-root case can reach a wallet.
const faults = [
  { id: 'access-untrusted', description: 'Wallet QA access certificate from an untrusted root', issuer: untrusted },
];

for (const tenant of tenants) {
  const config = path.join(configRoot, tenant);
  const tenantCa = path.join(ca, tenant);
  const tenantPub = path.join(pub, tenant);
  mkdirSync(tenantCa, { mode: 0o700 });
  mkdirSync(tenantPub);
  let template;
  for (const name of ['access', 'attestation', 'status-list', 'trust-list']) {
    const filename = path.join(config, 'key-chains', `${name}.json`);
    const document = JSON.parse(readFileSync(filename, 'utf8'));
    template ??= document;
    const { pair, certPath } = leaf(tenantCa, name, { issuer: trusted });
    writeFileSync(path.join(tenantPub, `${name}.pem`), readFileSync(certPath));
    const next = keyChainDocument(document, document.spec.id, document.spec.usageType, `Wallet QA test ${name}`, pair, certPath, trusted.cert);
    writeFileSync(filename, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  }
  // Only tenants that verify presentations need the broken access certificates.
  if (!existsSync(path.join(config, 'presentation'))) continue;
  for (const fault of faults) {
    const { pair, certPath } = leaf(tenantCa, fault.id, fault);
    const next = keyChainDocument(template, fault.id, 'access', fault.description, pair, certPath, fault.issuer.cert);
    writeFileSync(path.join(config, 'key-chains', `${fault.id}.json`), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  }
}

openssl('x509', '-in', trusted.cert, '-outform', 'DER', '-out', path.join(pub, 'wallet-qa-test-root.der'));

const certificate = new X509Certificate(readFileSync(trusted.cert));
writeFileSync(path.join(pub, 'trust.json'), JSON.stringify({
  profile: 'Wallet QA development trust; not production EUDI certification', eudiploHost: host, tenants,
  rootCertificate: 'test-root.pem', rootCertificateDer: 'wallet-qa-test-root.der',
  sha256: certificate.fingerprint256, validUntil: certificate.validTo,
  instructions: 'Install this root as a test trust anchor in your wallet. Leaf certificates last 365 days. TLS trust is configured separately.',
}, null, 2) + '\n');
// A deployment's overlay starts with just the key chains; everything else comes from git.
for (const tenant of tenants)
  cpSync(path.join(configRoot, tenant, 'key-chains'), path.join(root, 'overlay', tenant, 'key-chains'), { recursive: true });
console.log(`Generated isolated test fixtures in ${root}. Publish only ${pub}; keep ${ca} private.`);
