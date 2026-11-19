import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { PublishedResult } from './published.js';
import type { Run, Workspace } from './types.js';

/** Writes JSON to a file by atomic rename, readable only by the owner. */
export async function writeJsonAtomic(file: string, data: unknown) {
  const temporary = `${file}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(data));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

export interface RunStore {
  create(run: Run): Promise<Run>;
  get(id: string): Promise<Run | undefined>;
  list(): Promise<Run[]>;
  update<T>(id: string, operation: (run: Run) => Promise<T>): Promise<T>;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}
export class MissingRun extends Error {}

// A single-process store: runs live in memory and are committed to one JSON file
// by atomic rename. A PID lock keeps a second Wallet QA process off the same file.
export class FileRunStore implements RunStore {
  private queue: Promise<unknown> = Promise.resolve();
  private runs = new Map<string, Run>();
  private lockPath?: string;
  constructor(private file?: string) {}
  async init() {
    if (!this.file) return this;
    await mkdir(path.dirname(this.file), { recursive: true });
    this.lockPath = `${this.file}.lock`;
    try {
      const pid = Number(await readFile(this.lockPath, 'utf8'));
      try {
        process.kill(pid, 0);
        throw new Error(
          'Local run store is already in use. Stop the other Wallet QA process first.',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await unlink(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const lock = await open(this.lockPath, 'wx', 0o600);
    await lock.writeFile(String(process.pid));
    await lock.close();
    try {
      const data: Run[] = JSON.parse(await readFile(this.file, 'utf8'));
      this.runs = new Map(data.map((run) => [run.id, run]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await this.close();
        throw error;
      }
    }
    return this;
  }
  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async commit(next: Map<string, Run>) {
    if (this.file) await writeJsonAtomic(this.file, [...next.values()]);
    this.runs = next;
  }
  async create(run: Run) {
    return this.serialize(async () => {
      const next = new Map(this.runs);
      next.set(run.id, structuredClone(run));
      await this.commit(next);
      return structuredClone(run);
    });
  }
  async get(id: string) {
    const run = this.runs.get(id);
    return run && structuredClone(run);
  }
  async list() {
    return structuredClone([...this.runs.values()]);
  }
  async update<T>(id: string, operation: (run: Run) => Promise<T>) {
    return this.serialize(async () => {
      const current = this.runs.get(id);
      if (!current) throw new MissingRun();
      const run = structuredClone(current);
      const result = await operation(run);
      if (JSON.stringify(current) !== JSON.stringify(run)) {
        const next = new Map(this.runs);
        next.set(id, run);
        await this.commit(next);
      }
      return result;
    });
  }
  async delete(id: string) {
    await this.serialize(async () => {
      const next = new Map(this.runs);
      next.delete(id);
      await this.commit(next);
    });
  }
  async close() {
    await this.queue;
    if (this.lockPath) {
      await unlink(this.lockPath);
      this.lockPath = undefined;
    }
  }
}

export interface WorkspaceStore {
  get(id: string): Promise<Workspace | undefined>;
  put(workspace: Workspace): Promise<void>;
  list(): Promise<Workspace[]>;
  delete(id: string): Promise<void>;
}

// Workspaces are few and small; one JSON file next to the runs, written by atomic rename.
export class FileWorkspaceStore implements WorkspaceStore {
  private queue: Promise<unknown> = Promise.resolve();
  private items = new Map<string, Workspace>();
  constructor(private file?: string) {}
  async init() {
    if (!this.file) return this;
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const data: Workspace[] = JSON.parse(await readFile(this.file, 'utf8'));
      this.items = new Map(data.map((w) => [w.id, w]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return this;
  }
  // Every change is built and committed inside the queue, so concurrent writers never lose updates.
  private change(mutate: (next: Map<string, Workspace>) => void) {
    const result = this.queue.then(async () => {
      const next = new Map(this.items);
      mutate(next);
      if (this.file) await writeJsonAtomic(this.file, [...next.values()]);
      this.items = next;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  async get(id: string) {
    const item = this.items.get(id);
    return item && structuredClone(item);
  }
  async put(workspace: Workspace) {
    await this.change((next) => next.set(workspace.id, structuredClone(workspace)));
  }
  async list() {
    return structuredClone([...this.items.values()]);
  }
  async delete(id: string) {
    await this.change((next) => next.delete(id));
  }
}

export class PublishedStoreFull extends Error {}

export interface PublishedStore {
  /** Throws PublishedStoreFull when the store holds its maximum number of results. */
  add(result: PublishedResult): Promise<void>;
  list(): Promise<PublishedResult[]>;
  delete(id: string): Promise<boolean>;
}

/**
 * Published results in one JSON file next to the runs. Not subject to the
 * workspace retention: a result stays until an operator removes it.
 */
export class FilePublishedStore implements PublishedStore {
  private queue: Promise<unknown> = Promise.resolve();
  private items: PublishedResult[] = [];
  constructor(
    private file?: string,
    /** Published results are kept until removed; the cap bounds the file and the public feed. */
    private max = 1000,
  ) {}
  async init() {
    if (!this.file) return this;
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      this.items = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return this;
  }
  private change<T>(mutate: (next: PublishedResult[]) => T) {
    const result = this.queue.then(async () => {
      const next = structuredClone(this.items);
      const value = mutate(next);
      if (this.file) await writeJsonAtomic(this.file, next);
      this.items = next;
      return value;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  async add(item: PublishedResult) {
    await this.change((next) => {
      if (next.length >= this.max) throw new PublishedStoreFull();
      next.push(structuredClone(item));
    });
  }
  async list() {
    return structuredClone(this.items);
  }
  async delete(id: string) {
    return this.change((next) => {
      const index = next.findIndex((item) => item.id === id);
      if (index >= 0) next.splice(index, 1);
      return index >= 0;
    });
  }
}
