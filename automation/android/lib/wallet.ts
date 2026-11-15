/**
 * Appium session and UI helpers for the EU reference wallet (dev flavor, Wallet QA patch).
 *
 * Selectors prefer the wallet's own Compose test tags: the wallet sets testTagsAsResourceId at its
 * activity root, so a tag such as `request_screen_button` is the element's resource-id.
 */
import { remote, type Browser } from 'webdriverio';

export const appPackage = process.env.WALLET_APP_ID ?? 'eu.europa.ec.euidi.dev';
/** The PIN the onboarding sets and every later prompt expects. Test data, not a secret. */
export const walletPin = process.env.WALLET_PIN ?? '123456';

export async function startSession(): Promise<Browser> {
  return remote({
    hostname: process.env.APPIUM_HOST ?? '127.0.0.1',
    port: Number(process.env.APPIUM_PORT ?? 4723),
    logLevel: 'warn',
    connectionRetryTimeout: 180_000,
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:appPackage': appPackage,
      'appium:appActivity': process.env.WALLET_ACTIVITY ?? 'eu.europa.ec.assemblylogic.ui.MainActivity',
      'appium:noReset': true,
      'appium:autoGrantPermissions': true,
      'appium:newCommandTimeout': 600,
      'appium:uiautomator2ServerLaunchTimeout': 120_000,
      'appium:uiautomator2ServerInstallTimeout': 120_000,
      'appium:adbExecTimeout': 120_000,
      ...(process.env.ANDROID_SERIAL ? { 'appium:udid': process.env.ANDROID_SERIAL } : {}),
    },
  });
}

export const byTag = (tag: string) => `android=new UiSelector().resourceId("${tag}")`;
export const byText = (text: string) => `android=new UiSelector().text("${text}")`;
export const byTextContains = (text: string) => `android=new UiSelector().textContains("${text}")`;

/** Opens a wallet deep link (openid-credential-offer://, openid4vp://) in the wallet. */
export async function openDeepLink(driver: Browser, url: string) {
  await driver.execute('mobile: deepLink', { url, package: appPackage, waitForLaunch: true });
}

export async function waitFor(driver: Browser, selector: string, timeout = 30_000) {
  const element = driver.$(selector);
  await element.waitForDisplayed({ timeout, timeoutMsg: `Not shown within ${timeout} ms: ${selector}` });
  return element;
}

export async function isShown(driver: Browser, selector: string, timeout = 0) {
  const element = driver.$(selector);
  if (timeout > 0) return element.waitForDisplayed({ timeout }).then(() => true, () => false);
  return element.isDisplayed().catch(() => false);
}

export async function tap(driver: Browser, selector: string, timeout = 30_000) {
  await (await waitFor(driver, selector, timeout)).click();
}

/** All visible texts on screen, in UI hierarchy order. */
export async function visibleTexts(driver: Browser): Promise<string[]> {
  const xml = await driver.getPageSource();
  return [...xml.matchAll(/\btext="([^"]+)"/g)]
    .map((m) => m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim())
    .filter(Boolean);
}

/** Waits until one of the selectors is shown; returns its key. */
export async function waitForAny<K extends string>(
  driver: Browser,
  selectors: Record<K, string>,
  timeout = 30_000,
): Promise<K> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const [key, selector] of Object.entries(selectors) as [K, string][])
      if (await isShown(driver, selector)) return key;
    await driver.pause(500);
  }
  throw new Error(`None shown within ${timeout} ms: ${Object.values(selectors).join(', ')}`);
}
