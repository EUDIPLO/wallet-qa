import { Routes } from '@angular/router';

// /w/<workspace>?scenario=<id>&run=<id> are the links testers, the README and UI test runners use.
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./home/home').then((m) => m.HomePage),
    title: 'Wallet QA',
  },
  {
    path: 'w/:workspaceId',
    loadComponent: () => import('./workspace/workspace').then((m) => m.WorkspacePage),
    title: 'Wallet QA',
  },
  { path: '**', redirectTo: '' },
];
