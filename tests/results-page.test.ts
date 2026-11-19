// Runs public/results.js against a minimal fake DOM and a scripted feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync('public/results.js', 'utf8');
const html = readFileSync('public/results.html', 'utf8');

class Element {
  value = ''; textContent = ''; className = ''; tag: string;
  children: Element[] = []; onchange?: () => void;
  constructor(tag = 'div') { this.tag = tag; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  all(): Element[] { return this.children.flatMap((c) => [c, ...c.all()]); }
}

async function page(response: () => Response) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const context = vm.createContext({
    document: { getElementById: (id: string) => elements.get(id), createElement: (tag: string) => new Element(tag) },
    fetch: async () => response(),
  });
  vm.runInContext(source, context);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  return (id: string) => elements.get(id)!;
}

const result = (name: string, provenance: string) => ({
  id: name, publishedAt: '2026-11-18T10:00:00.000Z', provenance, instance: 'https://qa.test',
  wallet: { name, version: '1.0' },
  tests: [{ scenarioId: 'I-EAA-NOTX', label: 'Issue', section: 'Issuance', features: ['dpop'], verdict: 'passed', attested: true, testedAt: '2026-11-18T09:00:00.000Z', versions: { catalog: '3.0.0', eudiplo: '9.2.0' } }],
});
const feed = { features: [{ id: 'dpop', label: 'DPoP-bound access tokens', covered: true }, { id: 'dc-api', label: 'DC API', covered: false }], results: [result('<b>Wallet</b>', 'self-reported'), result('Other', 'instance')] };

test('the results page renders wallet text as text and filters by wallet', async () => {
  const el = await page(() => Response.json(feed));
  assert.equal(el('message').textContent, '');
  const headings = el('results').all().filter((e) => e.tag === 'h3').map((e) => e.textContent);
  assert.deepEqual(headings, ['<b>Wallet</b> 1.0', 'Other 1.0']);
  const texts = el('results').all().map((e) => e.textContent);
  assert.ok(texts.includes('Self-reported, uploaded to https://qa.test'));
  assert.ok(texts.includes('Recorded by the instance https://qa.test'));
  assert.ok(texts.includes(' tester-attested'));
  assert.ok(el('features').all().some((e) => e.textContent === ' — not covered'));

  el('walletFilter').value = 'Other';
  el('walletFilter').onchange!();
  assert.deepEqual(el('results').all().filter((e) => e.tag === 'h3').map((e) => e.textContent), ['Other 1.0']);
});

test('the results page says when the feed cannot be loaded', async () => {
  const el = await page(() => new Response('', { status: 500 }));
  assert.equal(el('message').textContent, 'Could not load the published results: HTTP 500');
});
