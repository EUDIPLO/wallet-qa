import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatToolbarModule } from '@angular/material/toolbar';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'qa-root',
  imports: [RouterOutlet, MatToolbarModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-toolbar class="app-bar">
      <a class="brand" href="/" data-testid="brand">Wallet QA</a>
      <span class="preview" title="Angular Material preview of the Wallet QA page">Preview</span>
    </mat-toolbar>
    <main class="page">
      <router-outlet />
    </main>
  `,
  styles: `
    .app-bar {
      position: sticky;
      top: 0;
      z-index: 2;
      gap: 12px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .brand {
      color: inherit;
      text-decoration: none;
      font: var(--mat-sys-title-large);
    }
    .preview {
      padding: 2px 10px;
      border-radius: var(--mat-sys-corner-full);
      background: var(--mat-sys-tertiary-container);
      color: var(--mat-sys-on-tertiary-container);
      font: var(--mat-sys-label-medium);
    }
    .page {
      box-sizing: border-box;
      width: 100%;
      max-width: 760px;
      margin: 0 auto;
      padding: 16px;
    }
    @media (max-width: 599px) {
      .page {
        padding: 12px 8px 24px;
      }
    }
  `,
})
export class App {}
