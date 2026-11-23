import { Routes } from '@angular/router';

// Served under /next/ (baseHref). /next/w/<workspace>?scenario=<id>&run=<id> mirrors the classic
// page's /w/<workspace> links.
export const routes: Routes = [
  {
    path: 'w/:workspaceId',
    loadComponent: () => import('./live-run/live-run').then((m) => m.LiveRunPage),
    title: 'Wallet QA',
  },
  {
    path: '**',
    loadComponent: () => import('./no-workspace').then((m) => m.NoWorkspacePage),
    title: 'Wallet QA',
  },
];
