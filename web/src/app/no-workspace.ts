import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { RouterLink } from '@angular/router';
import { storage } from './api';

/**
 * /next without a workspace. The preview has only the workspace screen; workspaces are still
 * created and joined on the classic page. The last workspace (same storage key as the classic
 * page) is offered when there is one.
 */
@Component({
  selector: 'qa-no-workspace',
  imports: [MatCardModule, MatButtonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined">
      <mat-card-header><h2 mat-card-title>Open a workspace</h2></mat-card-header>
      <mat-card-content>
        <p>
          This preview shows one workspace at <code>/next/w/&lt;workspace&gt;</code>. Create or join a
          workspace on the main page, then open its link here.
        </p>
      </mat-card-content>
      <mat-card-actions class="actions">
        @if (lastWorkspace) {
          <a
            matButton="filled"
            id="last-workspace"
            data-testid="last-workspace"
            [routerLink]="['/w', lastWorkspace]"
            queryParamsHandling="preserve"
            >Continue the last workspace</a
          >
        }
        <a
          [matButton]="lastWorkspace ? 'outlined' : 'filled'"
          href="/"
          id="classic-page"
          data-testid="classic-page"
          >Go to the main page</a
        >
      </mat-card-actions>
    </mat-card>
  `,
  styles: `
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 0 16px 16px;
    }
  `,
})
export class NoWorkspacePage {
  readonly lastWorkspace = storage.get('walletqa.lastWorkspace');
}
