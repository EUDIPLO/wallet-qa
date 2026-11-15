/**
 * The issuer metadata the wallet saw, fetched from EUDIPLO's public URL. The tests compare the
 * wallet's screens with it: the credential's display name and each claim's display name.
 * Node must trust deploy/tls/root.crt (run-tests.sh sets NODE_EXTRA_CA_CERTS).
 */
export const eudiploPublicUrl = process.env.EUDIPLO_PUBLIC_URL ?? 'https://localhost:3443';

export interface ClaimMeta {
  path: (string | number | null)[];
  /** en-US display name, if the issuer defines one. */
  label?: string;
}

export interface CredentialMeta {
  name?: string;
  hasBackgroundImage: boolean;
  claims: ClaimMeta[];
}

export async function credentialMetadata(tenant: string, configurationId: string): Promise<CredentialMeta> {
  const url = `${eudiploPublicUrl}/.well-known/openid-credential-issuer/issuers/${tenant}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Issuer metadata ${url}: HTTP ${response.status}`);
  const metadata = (await response.json()) as {
    credential_configurations_supported: Record<string, {
      credential_metadata?: {
        display?: { name?: string; locale?: string; background_image?: unknown }[];
        claims?: { path: (string | number | null)[]; display?: { name?: string; locale?: string }[] }[];
      };
    }>;
  };
  const config = metadata.credential_configurations_supported[configurationId];
  if (!config) throw new Error(`Issuer ${tenant} has no credential configuration ${configurationId}`);
  const english = <T extends { locale?: string }>(list: T[] = []) =>
    list.find((d) => d.locale?.startsWith('en')) ?? list[0];
  const display = english(config.credential_metadata?.display);
  return {
    name: display?.name,
    hasBackgroundImage: Boolean(display?.background_image),
    claims: (config.credential_metadata?.claims ?? []).map((c) => ({
      path: c.path,
      label: english(c.display)?.name,
    })),
  };
}

/** Top-level claims (path of length 1) with their display names. */
export function topLevelClaims(meta: CredentialMeta) {
  return meta.claims.filter((c) => c.path.length === 1).map((c) => ({ key: String(c.path[0]), label: c.label }));
}
