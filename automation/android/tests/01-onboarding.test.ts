/**
 * One-time wallet onboarding: welcome screen, create and confirm the PIN, "Your wallet is
 * secured!", home. On a wallet that is already set up (an emulator snapshot) it only unlocks.
 * Not a Wallet QA test; it prepares the wallet for the ones that follow.
 */
import { after, before, test } from 'node:test';
import type { Browser } from 'webdriverio';
import { Evidence } from '../lib/evidence.ts';
import { enterPin, screens, startSession, tap, waitFor, waitForAny } from '../lib/wallet.ts';

let driver: Browser;
const evidence = new Evidence('01-onboarding');

before(async () => {
  driver = await startSession();
});
after(async () => {
  await driver?.deleteSession();
});

test('the wallet is set up with a PIN and shows its home screen', async () => {
  const first = await waitForAny(driver, {
    welcome: screens.welcome,
    pinCreate: screens.pinCreate,
    login: screens.login,
    dashboard: screens.dashboard,
  }, 60_000);
  await evidence.step(driver, `start-${first}`);

  if (first === 'welcome') await tap(driver, screens.welcome);
  if (first === 'welcome' || first === 'pinCreate') {
    await waitFor(driver, screens.pinCreate);
    await enterPin(driver);
    await waitFor(driver, 'android=new UiSelector().text("Confirm PIN")');
    await evidence.step(driver, 'confirm-pin');
    await enterPin(driver);
    await waitFor(driver, screens.onboardingDone);
    await evidence.step(driver, 'wallet-secured');
    await tap(driver, screens.onboardingDone);
  }
  if (first === 'login') await enterPin(driver);

  await waitFor(driver, screens.dashboard, 60_000);
  await evidence.step(driver, 'home');
  evidence.write({ startedFrom: first });
});
