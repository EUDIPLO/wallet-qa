import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Api, ApiError, Scenario, Workspace, storage } from '../api';
import { E2E } from '../e2e';
import {
  ChecklistItem,
  Draft,
  LiveRun,
  RunControl,
  SyncState,
  answersToSend,
  awaitingWallet,
  badgeText,
  contractAttributes,
  qrValue,
  reasonText,
  stepText,
  transactionCodeText,
  verdictTone,
  walletLink,
} from './run-view';

const LAST_WORKSPACE_KEY = 'walletqa.lastWorkspace';
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Request failed');

/**
 * The workspace screen of the preview: pick a test, start it, follow the live run.
 * Behaviour follows the classic page (public/app.js): same API calls, same polling, same stored
 * run, same page contract. Every element a UI test taps or reads has a data-testid.
 */
@Component({
  selector: 'qa-live-run',
  imports: [
    MatButtonModule,
    MatCardModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
  ],
  templateUrl: './live-run.html',
  styleUrl: './live-run.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LiveRunPage implements OnInit {
  private readonly api = inject(Api);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  readonly e2e = inject(E2E);

  /** Route parameter and query parameters (withComponentInputBinding). */
  readonly workspaceId = input.required<string>();
  readonly scenario = input<string>();
  readonly run = input<string>();
  readonly timeoutSeconds = input<string>();

  readonly loading = signal(true);
  readonly workspace = signal<Workspace | undefined>(undefined);
  readonly scenarios = signal<Scenario[]>([]);
  readonly selectedId = signal('');
  readonly live = signal<LiveRun | undefined>(undefined);
  readonly sync = signal<SyncState>('idle');
  readonly emptyVerdict = signal('pending');
  readonly message = signal('');
  readonly starting = signal(false);
  readonly saving = signal(false);
  readonly pendingControls = signal<ReadonlySet<string>>(new Set());
  /** Unsaved checklist answers per run. */
  readonly drafts = signal<Record<string, Draft>>({});

  readonly selected = computed(() => this.scenarios().find((s) => s.id === this.selectedId()));
  readonly sections = computed(() => {
    const sections = new Map<string, Scenario[]>();
    for (const scenario of this.scenarios())
      sections.set(scenario.section, [...(sections.get(scenario.section) ?? []), scenario]);
    return [...sections].map(([name, items]) => ({ name, items }));
  });
  readonly workspaceSummary = computed(() => {
    const workspace = this.workspace();
    if (!workspace) return '';
    const { wallet } = workspace;
    return [workspace.tester, [wallet.name, wallet.version].filter(Boolean).join(' '), wallet.platform, wallet.device]
      .filter(Boolean)
      .join(' · ');
  });
  readonly contract = computed(() => contractAttributes(this.live(), this.sync(), this.emptyVerdict()));
  readonly badge = computed(() => badgeText(this.live()));
  readonly tone = computed(() => verdictTone(this.live()));
  readonly awaiting = computed(() => {
    const run = this.live();
    return !!run && awaitingWallet(run);
  });
  readonly walletUri = computed(() => {
    const run = this.live();
    return run ? walletLink(run) : undefined;
  });
  readonly qrSrc = computed(() => {
    const run = this.live();
    const value = run && qrValue(run);
    return value ? `/api/qr-code?value=${encodeURIComponent(value)}` : '';
  });
  readonly reason = computed(() => {
    const run = this.live();
    return run ? reasonText(run) : '';
  });
  readonly step = computed(() => {
    const run = this.live();
    return run ? stepText(run) : '';
  });
  readonly instruction = computed(() => (this.awaiting() ? (this.live()!.currentStep.instruction ?? '') : ''));
  readonly txCode = computed(() => {
    const run = this.live();
    return run ? transactionCodeText(run) : '';
  });

  private activeRunId?: string;
  private refreshing = false;
  private knownRunIds?: Set<string>;

  private get activeRunKey() {
    return `walletqa.activeRun.${this.workspaceId()}`;
  }
  private get ws() {
    return encodeURIComponent(this.workspaceId());
  }

  ngOnInit() {
    const visible = () => document.visibilityState !== 'hidden';
    const runTimer = setInterval(() => {
      if (visible() && !this.live()?.completed) void this.refreshActiveRun();
    }, 1000);
    const listTimer = setInterval(() => {
      if (visible() && this.workspace()) void this.loadRuns().catch(() => undefined);
    }, 3000);
    const refresh = () => {
      if (visible()) void this.refreshActiveRun();
    };
    window.addEventListener('pageshow', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    this.destroyRef.onDestroy(() => {
      clearInterval(runTimer);
      clearInterval(listTimer);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    });
    void this.init();
  }

  private async init() {
    try {
      const [workspace, { scenarios }] = await Promise.all([
        this.api.get<Workspace>(`/workspaces/${this.ws}`),
        this.api.get<{ scenarios: Scenario[] }>('/scenarios'),
      ]);
      this.workspace.set(workspace);
      this.scenarios.set(scenarios);
    } catch (error) {
      this.message.set(
        error instanceof ApiError && error.status === 404
          ? 'This workspace does not exist or has expired. Create a new one on the main page.'
          : `Could not load: ${errorText(error)}`,
      );
      storage.remove(LAST_WORKSPACE_KEY);
      this.loading.set(false);
      return;
    }
    storage.set(LAST_WORKSPACE_KEY, this.workspaceId());
    // Query parameters let a UI test open the page with its test preselected.
    const scenarios = this.scenarios();
    const preset =
      scenarios.find((s) => s.id === this.scenario()) ?? scenarios.find((s) => s.availability === 'ready');
    this.selectedId.set(preset?.id ?? '');
    this.loading.set(false);
    await this.loadRuns().catch(() => undefined);
    this.activeRunId = this.run() ?? storage.get(this.activeRunKey) ?? undefined;
    if (this.activeRunId) await this.refreshActiveRun();
    // Back from the wallet (?run=): show the result.
    if (this.run() && this.live()) this.revealLiveRun();
  }

  choose(id: string) {
    this.selectedId.set(id);
  }

  async start() {
    const scenario = this.selected();
    if (!scenario || scenario.availability !== 'ready') return;
    this.starting.set(true);
    const body: { scenarioId: string; timeoutSeconds?: number } = { scenarioId: scenario.id };
    const timeout = Number(this.timeoutSeconds());
    if (Number.isInteger(timeout) && timeout > 0) body.timeoutSeconds = timeout;
    try {
      this.selectRun(await this.api.post<LiveRun>(`/workspaces/${this.ws}/runs`, body));
      this.message.set('');
      this.revealLiveRun();
      await this.loadRuns();
    } catch (error) {
      this.message.set(errorText(error));
    } finally {
      this.starting.set(false);
    }
  }

  private selectRun(run: LiveRun) {
    this.activeRunId = run.id;
    storage.set(this.activeRunKey, run.id);
    this.show(run);
  }

  /** Scrolls the live run to the top, so Open wallet, transaction code and QR code are on screen. */
  private revealLiveRun() {
    afterNextRender(
      () => document.getElementById('liveRun')?.scrollIntoView({ block: 'start', behavior: this.e2e ? 'instant' : 'smooth' }),
      { injector: this.injector },
    );
  }

  private show(run: LiveRun) {
    this.live.set(run);
    this.sync.set('fresh');
  }

  private clearRun(verdict: string) {
    this.activeRunId = undefined;
    storage.remove(this.activeRunKey);
    this.live.set(undefined);
    this.emptyVerdict.set(verdict);
  }

  async refreshActiveRun() {
    if (!this.activeRunId || this.refreshing) return;
    const id = this.activeRunId;
    this.refreshing = true;
    this.sync.set('refreshing');
    try {
      const run = await this.api.get<LiveRun>(`/runs/${encodeURIComponent(id)}`);
      // An older in-flight poll must not replace a newly selected run.
      if (this.activeRunId === id) this.show(run);
    } catch (error) {
      if (this.activeRunId !== id) return;
      this.sync.set('error');
      if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
        this.clearRun('unavailable');
        this.message.set('The saved run has expired or was deleted.');
      } else this.message.set(errorText(error));
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * A run started on another device of this workspace takes over the live panel, so the phone
   * shows Open wallet for a run started on the laptop.
   */
  private async loadRuns() {
    const { runs } = await this.api.get<{ runs: LiveRun[] }>(`/workspaces/${this.ws}/runs`);
    const known = this.knownRunIds;
    this.knownRunIds = new Set(runs.map((run) => run.id));
    if (!known) return;
    const fresh = runs.find((run) => !known.has(run.id) && !run.completed && run.id !== this.activeRunId);
    if (fresh) {
      this.selectRun(fresh);
      this.revealLiveRun();
    }
  }

  openWallet() {
    const uri = this.walletUri();
    // selectRun has already stored the run ID, so the page finds the run again after the wallet.
    if (uri) window.location.assign(uri);
  }

  async useControl(control: RunControl) {
    const run = this.live();
    if (!run) return;
    this.pendingControls.update((ids) => new Set([...ids, control.id]));
    try {
      this.show(
        await this.api.post<LiveRun>(
          `/runs/${encodeURIComponent(run.id)}/controls/${encodeURIComponent(control.id)}`,
        ),
      );
      this.message.set(`${control.label}: done.`);
    } catch (error) {
      this.message.set(errorText(error));
    } finally {
      this.pendingControls.update((ids) => new Set([...ids].filter((id) => id !== control.id)));
    }
  }

  answerOf(item: ChecklistItem) {
    const run = this.live();
    return (run && this.drafts()[run.id]?.[item.id]?.answer) ?? item.answer;
  }

  noteOf(item: ChecklistItem) {
    const run = this.live();
    return (run && this.drafts()[run.id]?.[item.id]?.note) ?? item.note ?? '';
  }

  draft(item: ChecklistItem, change: { answer?: 'yes' | 'no'; note?: string }) {
    const run = this.live();
    if (!run) return;
    this.drafts.update((drafts) => {
      const current = drafts[run.id]?.[item.id] ?? { answer: item.answer ?? undefined, note: item.note ?? undefined };
      return { ...drafts, [run.id]: { ...drafts[run.id], [item.id]: { ...current, ...change } } };
    });
  }

  async saveAnswers() {
    const run = this.live();
    if (!run) return;
    const answers = answersToSend(this.drafts()[run.id] ?? {});
    if (!Object.keys(answers).length) {
      this.message.set('Choose Yes or No first.');
      return;
    }
    this.saving.set(true);
    try {
      this.show(await this.api.post<LiveRun>(`/runs/${encodeURIComponent(run.id)}/answers`, { answers }));
      this.drafts.update(({ [run.id]: _saved, ...rest }) => rest);
      this.message.set('Answers saved.');
    } catch (error) {
      this.message.set(errorText(error));
    } finally {
      this.saving.set(false);
    }
  }

  async downloadAudit() {
    const run = this.live();
    if (!run) return;
    try {
      const report = await this.api.get<unknown>(`/runs/${encodeURIComponent(run.id)}/report`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `wallet-qa-${run.id}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      this.message.set(errorText(error));
    }
  }

  async cancel() {
    const run = this.live();
    if (!run) return;
    try {
      await this.api.delete(`/runs/${encodeURIComponent(run.id)}`);
      this.clearRun('cancelled');
      this.message.set('Run cancelled.');
    } catch (error) {
      this.message.set(errorText(error));
    }
  }
}
