/**
 * Wallet QA access for the tests. Uses Wallet QA's own client (src/client.ts); if this directory
 * moves to another repository, replace this import with the published client or a copy.
 */
import { WalletQaClient } from '../../../src/client.ts';

export { WalletQaClient };

/** Wallet QA's API, as the test runner reaches it (plain HTTP on the host is fine). */
export const walletQaUrl = process.env.WALLET_QA_URL ?? 'http://localhost:8787';

/** One workspace per test session, shared by the test files through this env var when set. */
export async function client() {
  const qa = new WalletQaClient(walletQaUrl, process.env.WALLET_QA_WORKSPACE);
  if (!qa.workspaceId) {
    await qa.createWorkspace({
      tester: 'appium',
      wallet: {
        name: 'EUDI reference wallet (dev, Wallet QA patch)',
        version: process.env.WALLET_COMMIT,
        platform: 'Android emulator',
        device: process.env.ANDROID_DEVICE ?? 'emulator',
      },
    });
    process.env.WALLET_QA_WORKSPACE = qa.workspaceId;
  }
  return qa;
}
