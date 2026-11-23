import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';

/** The spike only has the workspace screen; workspaces are still created on the classic page. */
@Component({
  selector: 'qa-no-workspace',
  imports: [MatCardModule, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined">
      <mat-card-header><h2 mat-card-title>Open a workspace</h2></mat-card-header>
      <mat-card-content>
        <p>This preview shows one workspace at <code>/next/w/&lt;workspace&gt;</code>.
          Create or join a workspace on the main page, then open its link here.</p>
      </mat-card-content>
      <mat-card-actions>
        <a mat-flat-button href="/" data-testid="classic-page">Go to the main page</a>
      </mat-card-actions>
    </mat-card>
  `,
})
export class NoWorkspacePage {}
