/* Hosted snapshot support, loaded before app.js.
 *
 * The local dashboard reads /api/* from a Flask server. This copy has no server, so fetch() is
 * wrapped: every /api/* call is answered from the JSON files published beside the page, with the
 * same shapes the server returned. It also exposes TH, the chart and map colours read from the CSS
 * theme tokens, and fires "themechange" when the viewer switches between light and dark.
 */
'use strict';

window.TH = {};
function refreshTheme() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  Object.assign(window.TH, {
    surface: g('--surface-1'), ink: g('--text-primary'), text2: g('--text-secondary'), muted: g('--text-muted'),
    line: g('--map-line'), land: g('--map-land'), axis: g('--axis'), grid: g('--grid'),
  });
}
refreshTheme();
(function watchTheme() {
  let last = JSON.stringify(window.TH);
  const check = () => {
    refreshTheme();
    const now = JSON.stringify(window.TH);
    if (now !== last) { last = now; window.dispatchEvent(new Event('themechange')); }
  };
  try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', check); } catch (e) { /* old browser */ }
  new MutationObserver(check).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();

/* Every data file is published gzipped, under a .wasm name: all 53 weeks of 2025 at 5-minute
 * resolution only fit under the artifact's size limit compressed (about 4x on these bundles), and
 * .wasm is the served extension whose bytes the host hands back untouched -- a .json or .gz holding
 * gzip bytes is refused or not served at all. The browser inflates them with DecompressionStream.
 * The magic number decides, so a host that inflates the body itself, or a plain .json published
 * instead, both still work. */
const realFetch = window.fetch.bind(window);
async function loadJSON(path) {
  let r = await realFetch(path + '.wasm');
  if (!r.ok) {
    r = await realFetch(path);
    if (!r.ok) throw new Error(`could not load ${path} (HTTP ${r.status})`);
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  if (!(buf[0] === 0x1f && buf[1] === 0x8b)) return JSON.parse(new TextDecoder().decode(buf));
  if (typeof DecompressionStream !== 'function') {
    throw new Error('this browser cannot read the compressed data files (needs DecompressionStream)');
  }
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).json();
}
window.loadJSON = loadJSON;

(function serveApiFromFiles() {
  const loaded = new Map();
  const load = (key, path) => {
    if (!loaded.has(key)) {
      const p = loadJSON(path);
      p.catch(() => loaded.delete(key));
      loaded.set(key, p);
    }
    return loaded.get(key);
  };
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const mean = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

  // the aggregation /api/summary performed on the server, applied to the precomputed per-day rows
  const MEAN_KEYS = ['DA_cost_M', 'RT_cost_M', 'CA_DA_model', 'CA_DA_CAISO', 'CA_RT_model', 'CA_RT_CAISO', 'DA_smp', 'DA_congested'];
  const SUM_KEYS = ['DA_shed_MWh', 'RT_shed_MWh', 'DA_cshort_MWh'];
  async function summary(q) {
    const all = await load('summary', 'data/summary.json');
    const want = new Set((q.get('dates') || '').split(',').filter(Boolean));
    const pick = (days) => (want.size ? days.filter((d) => want.has(d.date)) : days);
    const v = q.get('variant');
    if (v) {
      if (!all[v]) return reply({ error: 'variant not found' }, 404);
      return reply({ variant: v, days: pick(all[v]) });
    }
    const rows = [];
    for (const [name, days] of Object.entries(all)) {
      const ds = pick(days);
      if (!ds.length) continue; // other study weeks have no days in this range
      const agg = { variant: name, nDA: ds.filter((d) => 'DA_cost_M' in d).length, nRT: ds.filter((d) => 'RT_cost_M' in d).length };
      for (const k of MEAN_KEYS) agg[k] = mean(ds.map((d) => d[k]));
      for (const k of SUM_KEYS) { const vals = ds.filter((d) => k in d).map((d) => d[k]); agg[k] = vals.length ? vals.reduce((s, x) => s + x, 0) : null; }
      rows.push(agg);
    }
    return reply({ variants: rows });
  }

  window.fetch = async function hostedFetch(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('/static/vendor/')) return realFetch('vendor/' + url.slice('/static/vendor/'.length), init);
    if (!url.startsWith('/api/')) return realFetch(input, init);
    const u = new URL(url, 'https://snapshot.local');
    const q = u.searchParams;
    try {
      switch (u.pathname) {
        case '/api/variants': return reply(await load('variants', 'data/variants.json'));
        case '/api/geo': return reply(await load('geo', 'data/geo.json'));
        case '/api/actual': return reply(await load('actual', 'data/actual.json'));
        case '/api/summary': return await summary(q);
        case '/api/report': {
          const rows = await load('metrics', 'data/metrics.json');
          window.METRICS = rows;
          return reply(rows);
        }
        case '/api/curve': {
          const v = q.get('variant');
          return reply(await load('curve:' + v, `data/curves/${encodeURIComponent(v)}.json`));
        }
        case '/api/day': {
          const v = q.get('variant');
          const bundle = await load('day:' + v, `data/days/${encodeURIComponent(v)}.json`);
          const day = bundle[`${q.get('date')}_${q.get('stage')}`];
          return day ? reply(day) : reply({ error: `no data for ${v} ${q.get('date')} ${q.get('stage')}` }, 404);
        }
        default:
          return reply({ error: 'This hosted copy is read-only. Model runs need the local dashboard.' }, 403);
      }
    } catch (e) {
      return reply({ error: e.message }, 500);
    }
  };
})();
