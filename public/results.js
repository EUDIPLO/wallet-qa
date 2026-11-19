// Public results page: reads the feed at /v1/published and renders it.
// Everything is rendered with textContent; uploaded wallet fields are not trusted.
const el = (id) => document.getElementById(id);
const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
let data = { features: [], results: [] };

const featureLabel = (id) => data.features.find((f) => f.id === id)?.label ?? id;
const walletTitle = (wallet) => [wallet.name, wallet.version].filter(Boolean).join(' ');
const date = (value) => new Date(value).toISOString().slice(0, 10);

function renderFeatures() {
  el('features').replaceChildren(...data.features.map((feature) => {
    const item = node('li', feature.label);
    if (!feature.covered) item.append(node('span', ' — not covered', 'muted'));
    return item;
  }));
}

function verdictCell(test) {
  const cell = node('td');
  const badge = node('span', test.verdict, `badge ${test.verdict}`);
  cell.append(badge);
  if (test.attested) cell.append(node('small', ' tester-attested'));
  return cell;
}

function renderResult(result) {
  const section = node('article', undefined, 'result');
  const heading = node('h3', walletTitle(result.wallet));
  const details = [result.wallet.platform, result.wallet.device].filter(Boolean).join(' · ');
  const provenance = result.provenance === 'instance'
    ? `Recorded by the instance ${result.instance}`
    : `Self-reported, uploaded to ${result.instance}`;
  section.append(
    heading,
    node('p', [details, `published ${date(result.publishedAt)}`].filter(Boolean).join(' · '), 'muted'),
    node('p', provenance, result.provenance === 'instance' ? 'muted' : 'warning'),
  );
  const table = node('table');
  const head = node('thead'); const headRow = node('tr');
  for (const title of ['Test', 'Verdict', 'Features', 'Tested', 'EUDIPLO']) headRow.append(node('th', title));
  head.append(headRow);
  const body = node('tbody');
  for (const test of result.tests) {
    const row = node('tr');
    const name = node('td'); name.append(node('strong', test.scenarioId), node('br'), node('small', test.label));
    row.append(
      name,
      verdictCell(test),
      node('td', test.features.map(featureLabel).join(', ')),
      node('td', date(test.testedAt)),
      node('td', `${test.versions.eudiplo} (catalog ${test.versions.catalog})`),
    );
    body.append(row);
  }
  table.append(head, body);
  const scroll = node('div', undefined, 'table-scroll');
  scroll.append(table);
  section.append(scroll);
  return section;
}

function render() {
  const filter = el('walletFilter').value;
  const results = data.results.filter((r) => !filter || r.wallet.name === filter);
  el('results').replaceChildren(...(results.length ? results.map(renderResult) : [node('p', 'No published results yet.', 'muted')]));
}

async function init() {
  try {
    const response = await fetch('/v1/published');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (error) {
    el('message').textContent = `Could not load the published results: ${error.message}`;
    return;
  }
  el('message').textContent = '';
  renderFeatures();
  const wallets = [...new Set(data.results.map((r) => r.wallet.name))].sort((a, b) => a.localeCompare(b));
  el('walletFilter').append(...wallets.map((name) => { const option = node('option', name); option.value = name; return option; }));
  el('walletFilter').onchange = render;
  render();
}
void init();
