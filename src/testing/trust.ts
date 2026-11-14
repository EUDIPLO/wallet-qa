// The trust setup of this Wallet QA instance: one EUDIPLO instance with a fixed set of
// tenants. Read-only: the certificates are part of the instance's config (the repository's
// eudiplo-config, plus a deployment's overlay). This check reports, per tenant, who issued its
// access certificate, so testers can see whether their wallet build fits the instance.
import { X509Certificate } from 'node:crypto';
import type { Backend } from './eudiplo.js';

export const ACCESS_KEY_CHAIN = 'access';

/** test-root: signed by this instance's generated Wallet QA test root; other: provided by the deployment (e.g. from a registrar). */
export type AccessCertificateSource = 'test-root' | 'other';
export type TenantTrust = {
  tenantId: string;
  profileIds: string[];
  description?: string;
  accessCertificate: {
    source: AccessCertificateSource;
    subject: string;
    issuer: string;
    validTo: string;
  } | null;
  error?: string;
  checkedAt: string;
};
type Tenant = { tenantId: string; profileIds: string[]; description?: string; backend: Backend };

const leaf = (pem: string) => {
  const first = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(pem);
  return first ? new X509Certificate(first[0]) : null;
};
const commonName = (dn: string) => /CN=([^\n,]+)/.exec(dn)?.[1] ?? dn;

export function classify(certificate: X509Certificate, testRoot?: X509Certificate): AccessCertificateSource {
  return testRoot && certificate.checkIssued(testRoot) && certificate.verify(testRoot.publicKey) ? 'test-root' : 'other';
}

export async function checkTenant(tenant: Tenant, testRoot?: X509Certificate, now = () => new Date()): Promise<TenantTrust> {
  const { tenantId, profileIds, description, backend } = tenant;
  const result: TenantTrust = { tenantId, profileIds, description, accessCertificate: null, checkedAt: now().toISOString() };
  if (!backend.accessCertificate) return result;
  try {
    const pem = await backend.accessCertificate(ACCESS_KEY_CHAIN);
    const certificate = pem ? leaf(pem) : null;
    if (certificate)
      result.accessCertificate = {
        source: classify(certificate, testRoot),
        subject: commonName(certificate.subject),
        issuer: commonName(certificate.issuer),
        validTo: new Date(certificate.validTo).toISOString(),
      };
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
  }
  return result;
}

/** Checks every tenant at startup, retries failures every minute and re-checks every ten minutes. */
export class TrustMonitor {
  private state: TenantTrust[] = [];
  private timer?: NodeJS.Timeout;
  constructor(
    private tenants: () => Tenant[],
    private testRoot?: X509Certificate,
    private options = { retryMs: 60_000, refreshMs: 10 * 60_000 },
  ) {}
  current() {
    return structuredClone(this.state);
  }
  async check() {
    this.state = await Promise.all(this.tenants().map((tenant) => checkTenant(tenant, this.testRoot)));
    for (const tenant of this.state)
      if (tenant.error) console.error(`Trust check for tenant ${tenant.tenantId} failed: ${tenant.error}`);
    return this.current();
  }
  start() {
    const run = async () => {
      await this.check().catch(() => undefined);
      const failed = this.state.some((tenant) => tenant.error);
      this.timer = setTimeout(run, failed ? this.options.retryMs : this.options.refreshMs);
      this.timer.unref();
    };
    void run();
  }
  stop() {
    clearTimeout(this.timer);
  }
}
