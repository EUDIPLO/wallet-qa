/**
 * Minimal Wallet QA client for automation (Maestro, Appium, CI). A workspace
 * ID is the access right; create one per test session or reuse a tester's.
 */
import type { Workspace } from './testing/types.js';
import type { liveRun } from './testing/engine.js';
export type LiveRun = ReturnType<typeof liveRun>;
export class WalletQaClient {
  constructor(
    private baseUrl: string,
    public workspaceId?: string,
  ) {}
  private async request<T>(
    route: string,
    options: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(
      `${this.baseUrl.replace(/\/$/, '')}/v1${route}`,
      {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(35000),
        headers: { 'Content-Type': 'application/json', ...options.headers },
      },
    );
    if (!response.ok) {
      const error = await response.json();
      throw new Error(
        `Wallet QA ${response.status}: ${error.error?.message ?? 'Request failed'}`,
      );
    }
    return response.status === 204 ? (undefined as T) : response.json();
  }
  private workspace() {
    if (!this.workspaceId) throw new Error('No workspace; call createWorkspace first');
    return encodeURIComponent(this.workspaceId);
  }
  async createWorkspace(input: Pick<Workspace, 'tester' | 'wallet'>) {
    const workspace = await this.request<Workspace>('/workspaces', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    this.workspaceId = workspace.id;
    return workspace;
  }
  create(input: { scenarioId: string; timeoutSeconds?: number }) {
    return this.request<LiveRun>(`/workspaces/${this.workspace()}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        scenarioId: input.scenarioId,
        timeoutSeconds: input.timeoutSeconds,
      }),
    });
  }
  get(id: string, waitMs = 0) {
    return this.request<LiveRun>(
      `/runs/${encodeURIComponent(id)}?waitMs=${waitMs}`,
    );
  }
  /** Answers checklist questions, e.g. { 'card-shown': 'yes' }. */
  answer(id: string, answers: Record<string, 'yes' | 'no'>) {
    return this.request<LiveRun>(`/runs/${encodeURIComponent(id)}/answers`, {
      method: 'POST',
      body: JSON.stringify({
        answers: Object.fromEntries(
          Object.entries(answers).map(([key, answer]) => [key, { answer }]),
        ),
      }),
    });
  }
  control(id: string, controlId: string) {
    return this.request<LiveRun>(
      `/runs/${encodeURIComponent(id)}/controls/${encodeURIComponent(controlId)}`,
      { method: 'POST' },
    );
  }
  async waitForStep(
    id: string,
    stepId: string,
    timeoutMs = 60000,
  ): Promise<LiveRun['currentStep']> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await this.get(id);
      if (run.completed)
        throw new Error(
          `Run finished before step ${stepId}: ${run.verdict} — ${run.reason}`,
        );
      if (
        run.currentStep.id === stepId &&
        run.currentStep.state === 'awaiting_wallet'
      )
        return run.currentStep;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for step ${stepId}`);
  }
  async assertPassed(id: string, timeoutMs = 60000): Promise<LiveRun> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await this.get(
        id,
        Math.max(0, Math.min(25000, deadline - Date.now())),
      );
      if (run.completed) {
        if (run.passed !== true)
          throw new Error(
            `Wallet QA ${run.verdict}: ${run.reason}\n${JSON.stringify(run.assertions)}`,
          );
        return run;
      }
    }
    throw new Error(
      'Timed out waiting for the Wallet QA verdict; pending is not a pass',
    );
  }
  delete(id: string) {
    return this.request<void>(`/runs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
}
