import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { LiveRun } from '../model/run-view';
import { Scenario, catalogSections, progressText, tagsOf } from '../model/workspace-view';

/** The test catalog: search, tag filter, and the tests by section with their latest status. */
@Component({
  selector: 'qa-catalog',
  imports: [MatFormFieldModule, MatInputModule, MatListModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="heading">
      <h2>Tests</h2>
      <span class="muted" id="progress" data-testid="progress">{{ progress() }}</span>
    </div>
    <div class="filters">
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Search</mat-label>
        <input
          matInput
          type="search"
          id="search"
          data-testid="search"
          placeholder="ID, name or tag"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
      </mat-form-field>
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Tag</mat-label>
        <!-- A native select: its picker is the platform's, which UI test runners drive reliably. -->
        <select matNativeControl id="tag-filter" data-testid="tag-filter" (change)="tag.set($any($event.target).value)">
          <option value="" [selected]="!tag()">All tags</option>
          @for (item of tags(); track item) {
            <option [value]="item" [selected]="item === tag()">{{ item }}</option>
          }
        </select>
      </mat-form-field>
    </div>
    <div id="test-list" data-testid="test-list">
      @for (section of sections(); track section.name) {
        <h3 class="section">{{ section.name }}</h3>
        <mat-action-list>
          @for (item of section.items; track item.scenario.id) {
            <button
              mat-list-item
              type="button"
              class="test"
              [class.unsupported]="item.scenario.availability !== 'ready'"
              [activated]="item.scenario.id === selectedId()"
              [attr.aria-current]="item.scenario.id === selectedId() ? 'true' : null"
              [id]="'test-' + item.scenario.id"
              [attr.data-testid]="'test-' + item.scenario.id"
              (click)="selected.emit(item.scenario.id)"
            >
              <span matListItemTitle class="test-id">{{ item.scenario.id }}</span>
              <span matListItemLine>{{ item.scenario.label }}</span>
              <span matListItemMeta class="meta"><span class="status" [class]="item.tone">{{ item.status }}</span></span>
            </button>
          }
        </mat-action-list>
      } @empty {
        <p class="muted">No test matches.</p>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .heading {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      h2 {
        margin: 0;
        font: var(--mat-sys-title-large);
      }
    }
    .filters {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 12px 0 4px;
    }
    .section {
      margin: 16px 0 0;
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .test {
      border-radius: var(--mat-sys-corner-medium);
    }
    .test.unsupported {
      opacity: 0.6;
    }
    .test-id {
      font-family: ui-monospace, monospace;
      font-size: 0.9em;
    }
    // Material tops the end slot of a two-line item and gives it a baseline spacer; the status
    // chip sits inside it, centred.
    .test .meta {
      align-self: center;
      margin: 0;
    }
    .test .meta::before {
      display: none;
    }
    .status {
      display: inline-block;
      padding: 2px 10px;
      line-height: 20px;
      border-radius: var(--mat-sys-corner-full);
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
      white-space: nowrap;
    }
    .status.passed {
      background: var(--qa-success-soft);
      color: var(--qa-success);
    }
    .status.failed {
      background: var(--qa-danger-soft);
      color: var(--qa-danger);
    }
    .status.running {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }
    .muted {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-medium);
    }
  `,
})
export class Catalog {
  readonly scenarios = input.required<Scenario[]>();
  readonly runs = input.required<LiveRun[]>();
  readonly selectedId = input('');
  readonly selected = output<string>();

  readonly query = signal('');
  readonly tag = signal('');
  readonly tags = computed(() => tagsOf(this.scenarios()));
  readonly progress = computed(() => progressText(this.scenarios(), this.runs()));
  readonly sections = computed(() => catalogSections(this.scenarios(), this.runs(), this.query(), this.tag()));
}
