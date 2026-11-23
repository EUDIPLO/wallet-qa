import { Injectable } from '@angular/core';

/** An error answer of the Wallet QA API, with its HTTP status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Workspace {
  id: string;
  tester?: string;
  wallet: { name: string; version?: string; platform?: string; device?: string };
}

export interface Scenario {
  id: string;
  section: string;
  label: string;
  description: string;
  profile: string;
  tags: string[];
  prerequisites: string[];
  requires?: string[];
  availability: string;
  unavailableReason?: string;
}

/** The Wallet QA HTTP API under /v1, the same one the classic page and the Maestro flows use. */
@Injectable({ providedIn: 'root' })
export class Api {
  async request<T>(route: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`/v1${route}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(data?.error?.message ?? 'Request failed', response.status);
    return data as T;
  }

  get<T>(route: string): Promise<T> {
    return this.request<T>(route);
  }

  post<T>(route: string, body: unknown = {}): Promise<T> {
    return this.request<T>(route, { method: 'POST', body: JSON.stringify(body) });
  }

  delete(route: string): Promise<null> {
    return this.request<null>(route, { method: 'DELETE' });
  }
}

/** localStorage that keeps working when storage is blocked (private mode, WebViews). */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* The page still works without it. */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* Nothing stored. */
    }
  },
};
