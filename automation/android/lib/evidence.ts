/**
 * Evidence for checklist answers. Every answer the tests send to Wallet QA comes from a UI
 * assertion; the screenshot and UI hierarchy taken at that moment are saved next to a JSON record
 * of what was checked, so a reviewer can see why the test answered as it did.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser } from 'webdriverio';

export const artifactsDir = path.resolve(
  process.env.ARTIFACTS_DIR ?? path.join(import.meta.dirname, '..', 'artifacts'),
);

export type Answer = 'yes' | 'no';

export interface Observation {
  /** Checklist question ID from Wallet QA's catalog, e.g. `card-shown`. */
  question: string;
  answer: Answer;
  /** What the test checked on screen, in words. */
  checked: string;
  /** Values found on screen that support the answer. */
  found: Record<string, unknown>;
  screenshot: string;
  hierarchy: string;
}

function safe(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/** Saves a screenshot and the UI hierarchy; returns their paths. */
export async function capture(driver: Browser, dir: string, name: string) {
  mkdirSync(dir, { recursive: true });
  const screenshot = path.join(dir, `${safe(name)}.png`);
  const hierarchy = path.join(dir, `${safe(name)}.xml`);
  await driver.saveScreenshot(screenshot);
  writeFileSync(hierarchy, await driver.getPageSource());
  return { screenshot, hierarchy };
}

/** Collects the observations of one run and writes them as `evidence.json`. */
export class Evidence {
  readonly dir: string;
  readonly observations: Observation[] = [];

  constructor(testName: string) {
    this.dir = path.join(artifactsDir, safe(testName));
    mkdirSync(this.dir, { recursive: true });
  }

  async step(driver: Browser, name: string) {
    return capture(driver, this.dir, name);
  }

  /**
   * Records an answer derived from a UI assertion. `assertion` returns the values it found and
   * whether the expectation holds; the answer is `yes` exactly when it holds.
   */
  async observe(
    driver: Browser,
    question: string,
    checked: string,
    assertion: () => Promise<{ holds: boolean; found: Record<string, unknown> }>,
  ): Promise<Answer> {
    const { holds, found } = await assertion();
    const files = await capture(driver, this.dir, `answer-${question}`);
    const answer: Answer = holds ? 'yes' : 'no';
    this.observations.push({ question, answer, checked, found, ...files });
    this.write();
    return answer;
  }

  answers(): Record<string, Answer> {
    return Object.fromEntries(this.observations.map((o) => [o.question, o.answer]));
  }

  write(extra: Record<string, unknown> = {}) {
    writeFileSync(
      path.join(this.dir, 'evidence.json'),
      JSON.stringify({ observations: this.observations, ...extra }, null, 2) + '\n',
    );
  }
}
