/**
 * Appium session and UI helpers for the EU reference wallet (dev flavor, Wallet QA patch).
 *
 * Selectors prefer the wallet's own Compose test tags: the wallet sets testTagsAsResourceId at its
 * activity root, so a tag such as `request_screen_button` becomes the resource-id
 * `eu.europa.ec.euidi.dev:id/request_screen_button`. Screens without tags are matched by their
 * English texts (the emulator runs in en-US).
 */
import { remote, type Browser } from 'webdriverio';

export const appPackage = process.env.WALLET_APP_ID ?? 'eu.europa.ec.euidi.dev';
export const appActivity = process.env.WALLET_ACTIVITY ?? 'eu.europa.ec.assemblylogic.ui.MainActivity';
/**
 * The PIN the onboarding sets and every later prompt expects. Test data, not a secret. The wallet
 * refuses repeated digits, sequences such as 123456 and common PINs.
 */
export const walletPin = process.env.WALLET_PIN ?? '258036';

export async function startSession(): Promise<Browser> {
  const driver = await remote({
    hostname: process.env.APPIUM_HOST ?? '127.0.0.1',
    port: Number(process.env.APPIUM_PORT ?? 4723),
    logLevel: 'warn',
    connectionRetryTimeout: 180_000,
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:appPackage': appPackage,
      'appium:appActivity': appActivity,
      'appium:noReset': true,
      'appium:autoGrantPermissions': true,
      'appium:newCommandTimeout': 600,
      'appium:uiautomator2ServerLaunchTimeout': 120_000,
      'appium:uiautomator2ServerInstallTimeout': 120_000,
      'appium:adbExecTimeout': 120_000,
      ...(process.env.ANDROID_SERIAL ? { 'appium:udid': process.env.ANDROID_SERIAL } : {}),
    },
  });
  // The wallet shows indeterminate spinners while it talks to EUDIPLO; waiting for an idle UI
  // would block every command until they stop.
  await driver.updateSettings({ waitForIdleTimeout: 0 });
  return driver;
}

export const byTag = (tag: string) => `id=${appPackage}:id/${tag}`;
export const byText = (text: string) => `android=new UiSelector().text("${text}")`;
export const byTextContains = (text: string) => `android=new UiSelector().textContains("${text}")`;
export const byDesc = (desc: string) => `android=new UiSelector().description("${desc}")`;

/** Screens the tests recognise, by a stable element on each. */
export const screens = {
  welcome: byText('Continue'),
  pinCreate: byTag('pin_screen_title'),
  login: byTag('biometric_screen_title'),
  pinConfirmAction: byTag('biometric_screen_pin_text'),
  onboardingDone: byTag('success_screen_primary_button'),
  dashboard: byTag('dashboard_screen_bottom_navigation_item_home'),
  offer: byTag('document_offer_screen_button'),
  issued: byText('Document issued'),
  request: byTag('request_screen_button'),
  shared: byTag('document_success_screen_content_header_description'),
  error: byText('Oups! Something went wrong'),
  rejectedByVerifier: byTextContains('which then rejected it'),
  issuanceBlocked: byText('Issuance blocked'),
};

/** Opens a wallet deep link (openid-credential-offer://, openid4vp://) in the wallet. */
export async function openDeepLink(driver: Browser, url: string) {
  await driver.execute('mobile: deepLink', { url, package: appPackage, waitForLaunch: true });
}

export async function waitFor(driver: Browser, selector: string, timeout = 30_000) {
  const element = driver.$(selector);
  await element.waitForDisplayed({ timeout, timeoutMsg: `Not shown within ${timeout} ms: ${selector}` });
  return element;
}

export async function isShown(driver: Browser, selector: string) {
  return driver.$(selector).isDisplayed().catch(() => false);
}

export async function tap(driver: Browser, selector: string, timeout = 30_000) {
  await (await waitFor(driver, selector, timeout)).click();
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
  throw new Error(
    `None of ${Object.keys(selectors).join(', ')} shown within ${timeout} ms. On screen: ${(await visibleTexts(driver)).join(' | ')}`,
  );
}

/** A node of the UI hierarchy with the attributes the tests use. */
export interface UiNode {
  text: string;
  desc: string;
  id: string;
  className: string;
  bounds: [number, number, number, number];
}

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Every node of the current screen, in hierarchy order. */
export async function nodes(driver: Browser): Promise<UiNode[]> {
  const xml = await driver.getPageSource();
  return [...xml.matchAll(/<[\w.$]+\s([^>]*?)\/?>/g)].map((m) => {
    const attr = (name: string) => unescape(m[1].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '');
    const b = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    return {
      text: attr('text').trim(),
      desc: attr('content-desc').trim(),
      id: attr('resource-id'),
      className: attr('class'),
      bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : [0, 0, 0, 0],
    };
  });
}

/** All visible texts on screen, in hierarchy order. */
export async function visibleTexts(driver: Browser): Promise<string[]> {
  return (await nodes(driver)).map((n) => n.text).filter(Boolean);
}

/** Nodes whose bounds lie inside the given node's bounds. */
export function inside(all: UiNode[], container: UiNode) {
  const [l, t, r, b] = container.bounds;
  return all.filter((n) => n !== container && n.bounds[0] >= l && n.bounds[1] >= t && n.bounds[2] <= r && n.bounds[3] <= b);
}

/** Types the wallet PIN into the PIN field on screen. */
export async function enterPin(driver: Browser) {
  const field = await waitFor(driver, 'android=new UiSelector().className("android.widget.EditText")');
  await field.click();
  await driver.keys(walletPin.split(''));
}

/** If the wallet asks for the PIN to unlock, enters it. */
export async function unlockIfLocked(driver: Browser) {
  if (await isShown(driver, screens.login)) {
    await enterPin(driver);
    await driver.$(screens.login).waitForDisplayed({ reverse: true, timeout: 30_000 });
  }
}

/** Scrolls down once; returns false when the screen did not change. */
export async function scrollDown(driver: Browser) {
  const before = (await visibleTexts(driver)).join('\n');
  const { width, height } = await driver.getWindowSize();
  await driver.execute('mobile: swipeGesture', {
    left: Math.round(width * 0.1), top: Math.round(height * 0.3),
    width: Math.round(width * 0.8), height: Math.round(height * 0.5),
    direction: 'up', percent: 0.75,
  });
  await driver.pause(700);
  return (await visibleTexts(driver)).join('\n') !== before;
}
