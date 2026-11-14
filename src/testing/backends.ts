import { readFileSync } from 'node:fs';
import { digest, EudiploBackend, type Backend } from './eudiplo.js';
import type { BackendBinding } from './types.js';

export type BackendProfile = {
  id: string;
  instanceId: string;
  tenantId: string;
  configVersion: string;
  eudiploVersion: string;
  baseUrl: string;
  publicUrl: string;
  clientId: string;
  clientSecret: string;
  /** What the tenant is for, shown on the start page. */
  description?: string;
};
type Entry = { binding: BackendBinding; backend: Backend; description?: string };

// Bindings contain no credentials or internal URLs. A changed destination cannot
// silently receive session reads or deletes belonging to an older run.
export class BackendRegistry {
  private entries = new Map<string, Entry>();
  constructor(entries: Entry[]) {
    for (const entry of entries) {
      if (this.entries.has(entry.binding.profileId))
        throw new Error('Duplicate backend profile');
      this.entries.set(entry.binding.profileId, {
        binding: structuredClone(entry.binding),
        backend: entry.backend,
        description: entry.description,
      });
    }
  }
  snapshot(profileId: string): BackendBinding {
    const entry = this.entries.get(profileId);
    if (!entry)
      throw new Error(`Backend profile ${profileId} is not configured`);
    return structuredClone(entry.binding);
  }
  resolve(binding: BackendBinding | undefined): Backend {
    if (!binding) throw new Error('Run has no persisted backend binding');
    const entry = this.entries.get(binding.profileId);
    if (!entry || entry.binding.identityHash !== binding.identityHash)
      throw new Error('The run backend binding is no longer available');
    return entry.backend;
  }
  profiles() {
    return [...this.entries.values()].map((entry) =>
      structuredClone(entry.binding),
    );
  }
  /** One entry per EUDIPLO tenant, with the profiles that use it. */
  tenants() {
    const tenants = new Map<string, { tenantId: string; profileIds: string[]; description?: string; backend: Backend }>();
    for (const entry of this.entries.values()) {
      const existing = tenants.get(entry.binding.tenantId);
      if (existing) {
        existing.profileIds.push(entry.binding.profileId);
        existing.description ??= entry.description;
      } else
        tenants.set(entry.binding.tenantId, {
          tenantId: entry.binding.tenantId,
          profileIds: [entry.binding.profileId],
          description: entry.description,
          backend: entry.backend,
        });
    }
    return [...tenants.values()];
  }
  async health() {
    await Promise.all(
      [...this.entries.values()].map((entry) => entry.backend.health()),
    );
  }
}

export function createBackendRegistry(
  profiles: BackendProfile[],
  origin: string,
  redirectUri: string,
) {
  return new BackendRegistry(
    profiles.map((profile) => {
      const {
        id: profileId,
        instanceId,
        tenantId,
        configVersion,
        eudiploVersion,
        baseUrl,
        publicUrl,
        clientId,
        description,
      } = profile;
      const identityHash = digest(
        JSON.stringify({
          profileId,
          instanceId,
          tenantId,
          configVersion,
          eudiploVersion,
          baseUrl,
          publicUrl,
          clientId,
        }),
      );
      return {
        binding: {
          profileId,
          instanceId,
          tenantId,
          configVersion,
          eudiploVersion,
          identityHash,
        },
        backend: new EudiploBackend({ ...profile, origin, redirectUri }),
        description,
      };
    }),
  );
}

export function loadBackendProfiles(
  filename: string,
  env: NodeJS.ProcessEnv = process.env,
): BackendProfile[] {
  const input: unknown = JSON.parse(readFileSync(filename, 'utf8'));
  if (!Array.isArray(input) || !input.length)
    throw new Error('Backend profiles must be a nonempty array');
  const ids = new Set<string>();
  const fields = [
    'id',
    'instanceId',
    'tenantId',
    'configVersion',
    'eudiploVersion',
    'baseUrl',
    'publicUrl',
    'clientId',
    'clientSecret',
  ] as const;
  return input.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid backend profile');
    const result = {} as BackendProfile;
    for (const field of fields) {
      const value = (entry as Record<string, unknown>)[field];
      if (typeof value !== 'string')
        throw new Error(`Backend profile requires ${field}`);
      result[field] = value.replace(
        /\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g,
        (_match, name: string, fallback?: string) => {
          const resolved = env[name] || fallback;
          if (!resolved)
            throw new Error(`Missing backend environment variable ${name}`);
          return resolved;
        },
      );
      if (!result[field].trim() || result[field].includes('${'))
        throw new Error(`Invalid backend profile ${field}`);
    }
    const description = (entry as Record<string, unknown>).description;
    if (description !== undefined) {
      if (typeof description !== 'string') throw new Error('Invalid backend profile description');
      result.description = description;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(result.id) || ids.has(result.id))
      throw new Error('Invalid or duplicate backend profile ID');
    ids.add(result.id);
    for (const field of ['baseUrl', 'publicUrl'] as const) {
      const url = new URL(result[field]);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new Error(`Backend ${field} must be an HTTP(S) origin`);
      result[field] = url.origin;
    }
    return result;
  });
}
