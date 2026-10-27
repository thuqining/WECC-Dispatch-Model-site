/* WECC zonal electricity market model dashboard – front end (no build step; uses Leaflet / topojson-client / Plotly) */
'use strict';

// ------------------------------------------------------------------ constants and helpers
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const pad = (n) => String(n).padStart(2, '0');
const FUEL_ZH = { Nuclear: 'Nuclear', Coal: 'Coal', Geothermal: 'Geothermal', Biomass: 'Biomass', Gas: 'Gas', Hydro: 'Hydro', Wind: 'Wind', Solar: 'Solar', Peaker: 'Peaker' };
const FUEL_COLOR = {
  Nuclear: '#4a3aa7', Coal: '#52514e', Geothermal: '#e87ba4', Biomass: '#008300', Gas: '#eb6834',
  Hydro: '#2a78d6', Wind: '#1baf7a', Solar: '#eda100', Peaker: '#e34948', Other: '#a3a29c', Storage: '#0d366b',
};
const C_MODEL = '#2a78d6', C_ACTUAL = '#eb6834', C_THIRD = '#1baf7a';
const BLUE_RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
const ORANGE_RAMP = ['#f9d3bf', '#f2a17c', '#eb6834', '#c24a1c', '#8f2d0b'];
const CA_AREAS = ['DLAP_PGAE (PG&E)', 'DLAP_SCE (SCE)', 'DLAP_SDGE (SDG&E)'];
const BIND_EPS = 1e-3;
const WECC_BOUNDS = [[31.2, -124.5], [49.2, -103.5]];
const nextFrame = () => new Promise((r) => setTimeout(r, 40));
const lineKey = (l) => l.name || l.bus; // lname can be missing in the model output

const S = {
  variants: [], dates: [], folders: [], variant: null, start: null, end: null, stage: 'DA', view: 'overview',
  geo: null, act: null, us: null, dirty: new Set(), mapDay: null, mapIdx: 17, mapArea: 14, playing: null,
  priceArea: 'DLAP_PGAE (PG&E)', loadArea: '__sys__', cgSel: null, cgSort: { key: 'rent', dir: -1 }, runKey: null, runTimer: null,
};

function fmt(x, d = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  return Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function sgn(x, d = 1) { return x === null || x === undefined ? '—' : (x > 0 ? '+' : '') + fmt(x, d); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function shortArea(a) { return a.replace(/\(\d+\)$/, ''); }
function toast(msg, ms = 4000) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
function mean(a) { const v = a.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }
function sum(a) { return a.reduce((s, x) => s + (x || 0), 0); }

const cache = new Map();
function getJSON(url) {
  if (!cache.has(url)) {
    const p = fetch(url).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url);
}
function clearVariantCache(v) {
  for (const k of Array.from(cache.keys())) if (k.includes('/api/summary') || k.includes(`variant=${encodeURIComponent(v)}&`)) cache.delete(k);
}
const dayUrl = (v, d, st) => `/api/day?variant=${encodeURIComponent(v)}&date=${d}&stage=${st}`;

function lerpColor(stops, t) {
  t = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = parseInt(stops[i].slice(1), 16), b = parseInt(stops[i + 1].slice(1), 16);
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
function quantile(arr, q) {
  const v = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return 0;
  const p = (v.length - 1) * q, i = Math.floor(p);
  return v[i] + (v[Math.min(i + 1, v.length - 1)] - v[i]) * (p - i);
}

// ------------------------------------------------------------------ Plotly common style
function merge(a, b) {
  const o = Object.assign({}, a);
  for (const k of Object.keys(b || {})) {
    o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' ? merge(a[k], b[k]) : b[k];
  }
  return o;
}
const baseLayout = () => ({
  margin: { l: 58, r: 16, t: 28, b: 42 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
  font: { family: '"Microsoft YaHei UI","PingFang SC","Segoe UI",sans-serif', size: 12, color: TH.text2 },
  xaxis: { gridcolor: TH.grid, linecolor: TH.axis, zeroline: false, automargin: true },
  yaxis: { gridcolor: TH.grid, linecolor: TH.axis, zeroline: false, automargin: true },
  legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: 12 } },
  hovermode: 'x unified', hoverlabel: { bgcolor: TH.surface, bordercolor: TH.axis, font: { size: 12, color: TH.ink } },
});
function plot(id, traces, layout = {}) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  return Plotly.react(el, traces, merge(baseLayout(), JSON.parse(JSON.stringify(layout))), { displaylogo: false, responsive: true, modeBarButtonsToRemove: ['lasso2d', 'select2d'] });
}
function emptyChart(id, msg) {
  plot(id, [], { xaxis: { visible: false }, yaxis: { visible: false }, annotations: [{ text: msg, showarrow: false, font: { size: 14, color: TH.muted }, xref: 'paper', yref: 'paper', x: 0.5, y: 0.5 }] });
}

// ------------------------------------------------------------------ data selection
const vinfo = () => S.variants.find((v) => v.name === S.variant) || { DA: [], RT: [] };
function selDates() { return S.dates.filter((d) => d >= S.start && d <= S.end); }
function stageDates(stage) { const a = new Set(vinfo()[stage]); return selDates().filter((d) => a.has(d)); }
async function loadDays(stage, dates) {
  const ds = dates || stageDates(stage);
  const js = await Promise.all(ds.map((d) => getJSON(dayUrl(S.variant, d, stage))));
  return ds.map((d, i) => ({ date: d, j: js[i] }));
}
function tstamp(stage, d, k) { return stage === 'DA' ? `${d} ${pad(k)}:00` : `${d} ${pad(Math.floor(k / 12))}:${pad((k % 12) * 5)}`; }
function times(days, stage) { const x = []; for (const { date, j } of days) for (let k = 0; k < j.T; k++) x.push(tstamp(stage, date, k)); return x; }
function series(days, field, a) {
  const y = [];
  for (const { j } of days) {
    const m = j[field];
    for (let k = 0; k < j.T; k++) { const r = m ? m[k] : null; y.push(a === undefined || a === null ? r : (Array.isArray(r) ? r[a] : null)); }
  }
  return y;
}
function rowSum(r) { return Array.isArray(r) ? sum(r) : (r || 0); }

function indexActual(act) {
  const ix = (arr) => new Map(arr.map((t, k) => [t, k]));
  act.idx = { DA: ix(act.caisoDA.times), RT: ix(act.caisoRT.times), eia: ix(act.eia.times), load: ix(act.loadAligned.times) };
}
function caisoAt(stage, nodes, t) {
  const src = stage === 'DA' ? S.act.caisoDA : S.act.caisoRT;
  const k = S.act.idx[stage].get(t);
  if (k === undefined) return null;
  return mean(nodes.filter((n) => src.nodes[n]).map((n) => src.nodes[n][k]));
}
function stageNodes(stage, area) {
  const ns = S.act.areaNodes[area] || [];
  return stage === 'DA' ? ns.filter((n) => S.act.caisoDA.nodes[n]) : ns;
}
function alignedLoad(area, t) {
  const k = S.act.idx.load.get(t.slice(0, 13) + ':00');
  return k === undefined ? null : S.act.loadAligned.areas[area][k];
}

// ------------------------------------------------------------------ initialization
async function init() {
  try {
    const [vr, geo, act, us] = await Promise.all([getJSON('/api/variants'), getJSON('/api/geo'), getJSON('/api/actual'), getJSON('/static/vendor/states-10m.json')]);
    S.geo = geo; S.act = act; S.us = us; indexActual(act);
    applyVariants(vr);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('weccDash') || '{}'); } catch (e) { saved = {}; }
    S.variant = S.variants.some((v) => v.name === saved.variant) ? saved.variant : (S.variants.find((v) => v.name === 'M2_2025-07-13') || S.variants[0] || {}).name;
    setRangeToVariant();
    fillGlobalSelects();
    bindUI();
    const view = (location.hash || '').slice(1);
    showView($(`#tabs button[data-view="${view}"]`) ? view : 'overview');
  } catch (e) {
    console.error(e);
    toast('Initialization failed: ' + e.message, 15000);
  }
}
function applyVariants(vr) {
  S.variants = vr.variants; S.dates = vr.dates; S.folders = vr.folders;
}
function fillGlobalSelects() {
  const weeks = [...new Set(S.variants.map((v) => v.week))];
  $('#selVariant').innerHTML = weeks.map((w) => `<optgroup label="${esc(w)}">${S.variants.filter((v) => v.week === w)
    .map((v) => `<option value="${esc(v.name)}">${esc(v.base)}${v.base === 'M2_2025-07-13' ? ' (recommended)' : ''}</option>`).join('')}</optgroup>`).join('');
  $('#selVariant').value = S.variant;
  fillDateSelects();
  syncStage();
}
function syncStage() {
  const hasRT = vinfo().RT.length > 0;
  const rtBtn = $('#segStage button[data-stage="RT"]');
  rtBtn.disabled = !hasRT;
  if (!hasRT && S.stage === 'RT') S.stage = 'DA';
  $$('#segStage button').forEach((b) => b.classList.toggle('on', b.dataset.stage === S.stage));
  const v = vinfo();
  const notes = [];
  if (!hasRT) notes.push('this variant has no RT results');
  if (v.stale) notes.push(`${v.stale} result files are newer than the JSON; export them on the Run page`);
  $('#stageNote').textContent = notes.join(' · ');
}
function bindUI() {
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#selVariant').addEventListener('change', (e) => { S.variant = e.target.value; saveState(); setRangeToVariant(); fillDateSelects(); syncStage(); globalChanged(); });
  $('#selStart').addEventListener('change', (e) => { S.start = e.target.value; if (S.end < S.start) { S.end = S.start; $('#selEnd').value = S.end; } globalChanged(); });
  $('#selEnd').addEventListener('change', (e) => { S.end = e.target.value; if (S.end < S.start) { S.start = S.end; $('#selStart').value = S.start; } globalChanged(); });
  $$('#segStage button').forEach((b) => b.addEventListener('click', () => { if (b.disabled) return; S.stage = b.dataset.stage; syncStage(); globalChanged(); }));

  // map
  $('#mapDay').addEventListener('change', (e) => { S.mapDay = e.target.value; renderMapFrame(true); });
  $('#mapSlider').addEventListener('input', (e) => { S.mapIdx = +e.target.value; renderMapFrame(false); });
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#chkLines').addEventListener('change', () => renderMapFrame(false));
  if ($('#chkArrows')) $('#chkArrows').addEventListener('change', () => renderMapFrame(false));
  $('#chkLabels').addEventListener('change', () => renderMapFrame(true));
  // prices
  $('#prArea').addEventListener('change', (e) => { S.priceArea = e.target.value; fillNodeSelect(); renderPrices(); });
  $('#prNode').addEventListener('change', () => renderPrices());
  // dispatch
  $('#dsFuel').addEventListener('change', () => renderDispatch());
  $('#dsStor').addEventListener('change', () => renderDispatch());
  // congestion
  $('#cgSearch').addEventListener('input', () => renderCongestionTable());
  $('#cgOnlyBind').addEventListener('change', () => renderCongestionTable());
  // load
  $('#ldStat').addEventListener('change', () => renderLoad());
  $('#ldArea').addEventListener('change', (e) => { S.loadArea = e.target.value; renderLoad(); });
  window.addEventListener('resize', () => { if (MAP) MAP.invalidateSize(); if (LMAP) LMAP.invalidateSize(); });
}
function saveState() { try { localStorage.setItem('weccDash', JSON.stringify({ variant: S.variant })); } catch (e) { /* ignore */ } }
function globalChanged() {
  $$('#tabs button').forEach((b) => S.dirty.add(b.dataset.view));
  renderView(S.view);
}
function showView(view) {
  S.view = view;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $$('.view').forEach((s) => { s.hidden = s.id !== `view-${view}`; });
  try { history.replaceState(null, '', '#' + view); } catch (e) { /* sandboxed viewer */ }
  if (view !== 'map') stopPlay();
  $('#globalControls').style.visibility = view === 'run' ? 'hidden' : 'visible';
  renderView(view, true);
}
const RENDERERS = {};
async function renderView(view, fromTab) {
  if (fromTab && !S.dirty.has(view) && RENDERERS[view]?.done) {
    $$(`#view-${view} .js-plotly-plot`).forEach((el) => Plotly.Plots.resize(el));
    if (view === 'map' && MAP) MAP.invalidateSize();
    if (view === 'load' && LMAP) LMAP.invalidateSize();
    if (view === 'run') refreshRunView();
    return;
  }
  if (S.view !== view) return;
  S.dirty.delete(view);
  try {
    await ({ overview: renderOverview, map: renderMap, prices: renderPrices, dispatch: renderDispatch, congestion: renderCongestion, load: renderLoad, curve: window.renderCurve, year: window.renderYear, run: refreshRunView })[view]();
    RENDERERS[view] = { done: true };
  } catch (e) {
    console.error(e);
    toast(`Error rendering "${view}": ${e.message}`, 8000);
  }
}

// ------------------------------------------------------------------ overview
async function renderOverview() {
  const dates = selDates().join(',');
  const [sm, all, screen] = await Promise.all([
    getJSON(`/api/summary?variant=${encodeURIComponent(S.variant)}&dates=${dates}`),
    getJSON(`/api/summary?dates=${dates}`),
    getJSON('/api/report?name=variant_screening_DA.csv').catch(() => []),
  ]);
  const days = sm.days;
  const g = (k) => days.map((d) => d[k] ?? null);
  const nDA = g('DA_cost_M').filter((x) => x !== null).length, nRT = g('RT_cost_M').filter((x) => x !== null).length;
  const caDA = mean(g('CA_DA_model')), caDAc = mean(g('CA_DA_CAISO')), caRT = mean(g('CA_RT_model')), caRTc = mean(g('CA_RT_CAISO'));
  const tiles = [
    { l: 'DA operating cost, daily mean', v: fmt(mean(g('DA_cost_M')), 2), u: 'M$/day', f: nDA ? `total <b>${fmt(sum(g('DA_cost_M')), 1)}</b> M$ · ${nDA} days` : 'no DA data' },
    { l: 'RT operating cost, daily mean', v: nRT ? fmt(mean(g('RT_cost_M')), 2) : '—', u: nRT ? 'M$/day' : '', f: nRT ? `total <b>${fmt(sum(g('RT_cost_M')), 1)}</b> M$ · ${nRT} days` : 'this variant has no RT results' },
    { l: 'Load shed', v: fmt(sum(g('DA_shed_MWh')), 0), u: 'MWh (DA)', f: `RT <b>${nRT ? fmt(sum(g('RT_shed_MWh')), 0) : '—'}</b> MWh · reserve shortfall <b>${fmt(sum(g('DA_cshort_MWh')), 0)}</b> MWh` },
    { l: 'California DA LMP (load-weighted)', v: fmt(caDA, 1), u: '$/MWh', f: `CAISO DLAP <b>${fmt(caDAc, 1)}</b> · bias <b>${sgn(caDA !== null && caDAc !== null ? caDA - caDAc : null)}</b>` },
    { l: 'California RT LMP (load-weighted)', v: nRT ? fmt(caRT, 1) : '—', u: nRT ? '$/MWh' : '', f: nRT ? `CAISO RT <b>${fmt(caRTc, 1)}</b> · bias <b>${sgn(caRT - caRTc)}</b>` : 'this variant has no RT results' },
    { l: 'DA system energy price (SMP), mean', v: fmt(mean(g('DA_smp')), 1), u: '$/MWh', f: `congested lines per day <b>${fmt(mean(g('DA_congested')), 0)}</b>` },
  ];
  $('#kpis').innerHTML = tiles.map((t) => `<div class="kpi"><div class="lbl">${t.l}</div><div class="val">${t.v}<span class="unit">${t.u}</span></div><div class="foot">${t.f}</div></div>`).join('');

  const x = g('date');
  const tr = [{ type: 'bar', name: 'DA', x, y: g('DA_cost_M'), marker: { color: C_MODEL }, hovertemplate: '%{y:.2f} M$' }];
  if (nRT) tr.push({ type: 'bar', name: 'RT', x, y: g('RT_cost_M'), marker: { color: C_ACTUAL }, hovertemplate: '%{y:.2f} M$' });
  plot('chCost', tr, { barmode: 'group', bargap: 0.35, bargroupgap: 0.08, yaxis: { title: 'M$', rangemode: 'tozero' }, xaxis: { type: 'category' } });

  const ln = (name, y, color, dash) => ({ type: 'scatter', mode: 'lines+markers', name, x, y, line: { color, width: 2, dash }, marker: { size: 8, line: { color: TH.surface, width: 2 } }, hovertemplate: '%{y:.1f}' });
  const tr2 = [ln('Model DA', g('CA_DA_model'), C_MODEL), ln('CAISO DA', g('CA_DA_CAISO'), C_ACTUAL)];
  if (nRT) tr2.push(ln('Model RT', g('CA_RT_model'), C_MODEL, 'dot'), ln('CAISO RT', g('CA_RT_CAISO'), C_ACTUAL, 'dot'));
  plot('chCaDaily', tr2, { yaxis: { title: '$/MWh' }, xaxis: { type: 'category' } });

  const scr = new Map((screen || []).map((r) => [r.Row, r]));
  const cols = [
    ['variant', 'Variant', 'l'], ['nDA', 'DA days', 0], ['nRT', 'RT days', 0], ['DA_cost_M', 'DA cost M$/day', 2], ['RT_cost_M', 'RT cost M$/day', 2],
    ['DA_smp', 'DA SMP', 1], ['CA_DA_model', 'CA DA model', 1], ['CA_DA_CAISO', 'CAISO DA', 1], ['_bias', 'DA bias', 1],
    ['_mae', 'RT MAE*', 1], ['_corr', 'RT corr*', 2], ['_v5', '5-min chg*', 2], ['CA_RT_model', 'CA RT model', 1], ['CA_RT_CAISO', 'CAISO RT', 1],
    ['DA_shed_MWh', 'DA shed MWh', 0], ['DA_cshort_MWh', 'Reserve shortfall MWh', 0], ['DA_congested', 'Congested lines/day', 0],
  ];
  const rows = all.variants.map((r) => Object.assign({}, r, {
    _bias: r.CA_DA_model !== null && r.CA_DA_CAISO !== null ? r.CA_DA_model - r.CA_DA_CAISO : null,
    _mae: scr.has(r.variant) ? +scr.get(r.variant).hourly_MAE : null,
    _corr: scr.has(r.variant) ? +scr.get(r.variant).hourly_corr : null,
    _v5: scr.has(r.variant) ? +scr.get(r.variant).mean_abs_5min_change : null,
  }));
  $('#tblVariants').innerHTML = `<thead><tr>${cols.map((c) => `<th class="${c[2] === 'l' ? 'l' : ''}">${c[1]}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr class="${r.variant === S.variant ? 'sel' : ''}">${cols.map((c) => c[2] === 'l'
    ? `<td class="l"><span class="link" data-v="${esc(r.variant)}">${esc(r.variant)}</span>${r.variant === S.variant ? '<span class="tag cur">current</span>' : ''}</td>`
    : `<td>${c[0].startsWith('n') ? (r[c[0]] ?? '—') : c[0] === '_bias' ? sgn(r[c[0]], 1) : fmt(r[c[0]], c[2])}</td>`).join('')}</tr>`).join('')}</tbody>
    <caption style="caption-side:bottom;text-align:left" class="muted small">* Real-time hourly MAE, correlation and mean absolute 5-minute price change against CAISO (3-DLAP average), whole week, after the 2026-09-16 corrections. CAISO's own 5-minute change: ${CAISO_V5()}. California price = load-weighted PG&amp;E/SCE/SDG&amp;E.</caption>`;
  $$('#tblVariants .link').forEach((el) => el.addEventListener('click', () => { S.variant = el.dataset.v; $('#selVariant').value = S.variant; saveState(); setRangeToVariant(); fillDateSelects(); syncStage(); globalChanged(); }));
}

// ------------------------------------------------------------------ map
let MAP = null, TILES = null, STATES = null, AREA_LAYER = null, LINE_LAYER = null, AREA_MARKERS = [];
function statesLayer(map, pane) {
  const feat = topojson.feature(S.us, S.us.objects.states);
  return L.geoJSON(feat, { pane, interactive: false, style: { color: TH.line, weight: 0.8, fillColor: TH.land, fillOpacity: 1 } }).addTo(map);
}
function flowArrow(q1, q2, fwd, color, l, tipHtml) {
  // A chevron at the middle of the drawn line, pointing the way the power flows. The angle is taken
  // in screen space (latLngToLayerPoint), not from the raw coordinates, so it still lies along the
  // line once Mercator has stretched it; initMap redraws the frame on zoom for the same reason.
  const A = fwd ? q1 : q2, B = fwd ? q2 : q1;
  const pa = MAP.latLngToLayerPoint(A), pb = MAP.latLngToLayerPoint(B);
  const deg = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
  const mid = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2];
  const icon = L.divIcon({
    className: '', iconSize: [16, 16], iconAnchor: [8, 8],
    html: `<svg width="16" height="16" viewBox="0 0 16 16" style="transform:rotate(${deg}deg);overflow:visible">` +
          `<path d="M3 3.5 L10.5 8 L3 12.5 Z" fill="${color}" style="stroke:var(--surface-1,#fcfcfb);stroke-width:1.4;stroke-linejoin:round"/></svg>`,
  });
  L.marker(mid, { icon, pane: 'lines', interactive: true })
    .bindTooltip(tipHtml, { className: 'tip', sticky: true }).addTo(LINE_LAYER);
}
function initMap() {
  if (MAP) return;
  MAP = L.map('map', { zoomSnap: 0.25, minZoom: 3, maxZoom: 10 });
  MAP.createPane('states'); MAP.getPane('states').style.zIndex = 250;
  MAP.createPane('lines'); MAP.getPane('lines').style.zIndex = 390;
  STATES = statesLayer(MAP, 'states');
  TILES = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 10, opacity: 0.6, attribution: '&copy; OpenStreetMap' });
  LINE_LAYER = L.layerGroup().addTo(MAP);
  AREA_LAYER = L.layerGroup().addTo(MAP);
  MAP.on('zoomend', () => renderMapFrame(false));
  MAP.attributionControl.addAttribution('Area positions are schematic');
}
function toggleTiles() {
  if (!MAP) return;
  if ($('#chkTiles').checked) { TILES.addTo(MAP); STATES.setStyle({ fillOpacity: 0, color: TH.muted }); } else { MAP.removeLayer(TILES); STATES.setStyle({ fillOpacity: 1, color: TH.line }); }
}
async function renderMap() {
  initMap();
  await nextFrame(); MAP.invalidateSize();
  if (!MAP._fitted) { MAP.fitBounds(WECC_BOUNDS); MAP._fitted = true; }
  const ds = stageDates(S.stage);
  $('#mapDay').innerHTML = ds.map((d) => `<option>${d}</option>`).join('');
  if (!ds.includes(S.mapDay)) S.mapDay = ds.includes('2024-08-02') ? '2024-08-02' : ds[0];
  $('#mapDay').value = S.mapDay || '';
  const T = S.stage === 'DA' ? 24 : 288;
  const sl = $('#mapSlider');
  if (+sl.max !== T - 1) { S.mapIdx = S.stage === 'DA' ? Math.floor(S.mapIdx / 12) : S.mapIdx * 12; sl.max = T - 1; }
  S.mapIdx = Math.min(S.mapIdx, T - 1); sl.value = S.mapIdx;
  await renderMapFrame(true);
}
const MAP_CTX = {};
async function mapContext() {
  const key = `${S.variant}|${S.mapDay}|${S.stage}`;
  if (MAP_CTX.key === key) return MAP_CTX;
  const main = await getJSON(dayUrl(S.variant, S.mapDay, S.stage));
  let da = main;
  if (S.stage === 'RT') da = vinfo().DA.includes(S.mapDay) ? await getJSON(dayUrl(S.variant, S.mapDay, 'DA')) : null;
  const lineRT = S.stage === 'RT' && Array.isArray(main.lines);
  const lsrc = lineRT ? main : da;
  const allLmp = main.lmp.flat();
  const lo = quantile(allLmp, 0.05), hi = quantile(allLmp, 0.9);
  let maxLoad = 1;
  for (let k = 0; k < 24; k++) for (let a = 0; a < 19; a++) {
    const v = S.stage === 'DA' ? main.D[k][a] : main.D ? main.D[k * 12][a] : alignedLoad(main.areas[a], `${S.mapDay} ${pad(k)}:00`);
    if (v > maxLoad) maxLoad = v;
  }
  let maxMu = 0;
  if (lsrc) for (const l of lsrc.lines) for (const m of l.mu) maxMu = Math.max(maxMu, Math.abs(m));
  Object.assign(MAP_CTX, { key, main, da, lsrc, lineRT, lo, hi: hi > lo ? hi : lo + 1, maxLoad, maxMu: maxMu || 1 });
  return MAP_CTX;
}
async function renderMapFrame(rebuild) {
  if (!MAP || !S.mapDay) return;
  const ctx = await mapContext();
  const { main, da, lsrc, lineRT } = ctx;
  const k = S.mapIdx, isRT = S.stage === 'RT', h = isRT ? Math.floor(k / 12) : k;
  const li = lineRT ? k : h;   // line index: 5-min interval (RT lines) or hour (DA lines)
  const t = tstamp(S.stage, S.mapDay, k);
  $('#mapTime').textContent = `${t} MDT${isRT ? ' (5-min)' : ''}`;
  const areas = main.areas;
  const C = S.geo.centroids;
  if (rebuild || AREA_MARKERS.length !== areas.length) {
    AREA_LAYER.clearLayers(); AREA_MARKERS = [];
    areas.forEach((a, i) => {
      const m = L.circleMarker([C[a].lat, C[a].lon], { radius: 10, color: TH.surface, weight: 2, fillOpacity: 0.92 });
      m.on('click', () => { S.mapArea = i; renderMapFrame(false); });
      if ($('#chkLabels').checked) m.bindTooltip(shortArea(a), { permanent: true, direction: 'right', offset: [8, 0], className: 'area-label' });
      m.addTo(AREA_LAYER); AREA_MARKERS.push(m);
    });
  }
  areas.forEach((a, i) => {
    const p = main.lmp[k][i];
    const load = isRT ? (main.D ? main.D[k][i] : alignedLoad(a, t)) : main.D[h][i];
    const m = AREA_MARKERS[i];
    m.setStyle({ fillColor: lerpColor(BLUE_RAMP, (p - ctx.lo) / (ctx.hi - ctx.lo)), color: i === S.mapArea ? TH.ink : TH.surface, weight: i === S.mapArea ? 3 : 2 });
    m.setRadius(4 + 20 * Math.sqrt(Math.max(load || 0, 0) / ctx.maxLoad));
    if (!$('#chkLabels').checked) {
      m.unbindTooltip();
      m.bindTooltip(`<b>${esc(a)}</b><br>LMP ${fmt(p, 2)} $/MWh<br>Load ${fmt(load, 0)} MW`, { className: 'tip' });
    }
  });
  // lines
  LINE_LAYER.clearLayers();
  let nShown = 0, nUnk = 0;
  if ($('#chkLines').checked && lsrc) {
    const pairs = new Map(), intra = new Map();
    const active = lsrc.lines.filter((l) => Math.abs(l.mu[li]) > BIND_EPS || Math.abs(l.flow[li]) >= 0.9 * l.Flim);
    for (const l of active) {
      const g = S.geo.lines[lineKey(l)];
      if (!g) { nUnk++; continue; }
      if (g.f === g.t) { if (!intra.has(g.f)) intra.set(g.f, []); intra.get(g.f).push(l); } else {
        const key = [g.f, g.t].sort().join('|'); if (!pairs.has(key)) pairs.set(key, []); pairs.get(key).push(l);
      }
    }
    const tip = (l) => {
      const g = S.geo.lines[lineKey(l)];
      const ld = l.Flim ? Math.abs(l.flow[li]) / l.Flim * 100 : null;
      return `<b>${esc(lineKey(l))}</b><br>${esc(l.bus)}<br>Areas: ${esc(shortArea(g.f))} → ${esc(shortArea(g.t))}${g.ext && g.ext.length ? ` (includes external area ${esc(g.ext.join(','))}, drawn at the nearest area)` : ''}` +
        `<br>Flow ${fmt(l.flow[li], 0)} MW / limit ${fmt(l.Flim, 0)} MW (${fmt(ld, 0)}%)<br>Shadow price ${fmt(l.mu[li], 2)} $/MWh<br><span style="color:${TH.muted}">${lineRT ? 'RT ' + t.slice(11) : 'DA ' + pad(h) + ':00'} · endpoint mapping ${g.fsrc}/${g.tsrc}</span>`;
    };
    const arrows = $('#chkArrows') ? $('#chkArrows').checked : true;
    const style = (l) => {
      const mu = Math.abs(l.mu[li]);
      const bind = mu > BIND_EPS;
      return { color: bind ? lerpColor(ORANGE_RAMP, 0.25 + 0.75 * mu / ctx.maxMu) : TH.line, weight: bind ? 3 + 3 * Math.min(1, mu / ctx.maxMu) : 2, dashArray: bind ? null : '5 5', opacity: 0.95 };
    };
    for (const [key, ls] of pairs) {
      const [a, b] = key.split('|');
      const p1 = [C[a].lat, C[a].lon], p2 = [C[b].lat, C[b].lon];
      const dx = p2[1] - p1[1], dy = p2[0] - p1[0], len = Math.hypot(dx, dy) || 1;
      ls.sort((x, y) => Math.abs(y.mu[li]) - Math.abs(x.mu[li]));
      ls.forEach((l, i) => {
        const off = (i - (ls.length - 1) / 2) * 0.14;
        const ox = -dy / len * off, oy = dx / len * off;
        const q1 = [p1[0] + oy, p1[1] + ox], q2 = [p2[0] + oy, p2[1] + ox];
        L.polyline([q1, q2], Object.assign({ pane: 'lines' }, style(l))).bindTooltip(tip(l), { className: 'tip', sticky: true }).addTo(LINE_LAYER);
        if (arrows && Math.abs(l.flow[li]) >= 1) {
          const g = S.geo.lines[lineKey(l)];
          // flow > 0 runs from the line's "from" bus to its "to" bus; the pair is drawn a..b in
          // alphabetical order, so the arrow follows the drawn line only when a is the from-area
          const fwd = (a === g.f) === (l.flow[li] >= 0);
          flowArrow(q1, q2, fwd, style(l).color, l, tip(l));
        }
        nShown++;
      });
    }
    for (const [a, ls] of intra) {
      ls.sort((x, y) => Math.abs(y.mu[li]) - Math.abs(x.mu[li]));
      ls.forEach((l, i) => {
        const ang = (-60 + i * 32) * Math.PI / 180, r = 0.75 + 0.3 * Math.floor(i / 11);
        const pos = [C[a].lat + r * Math.sin(ang) * 0.8, C[a].lon + r * Math.cos(ang)];
        const st = style(l);
        const icon = L.divIcon({ className: '', iconSize: [12, 12], html: `<div style="width:11px;height:11px;transform:rotate(45deg);background:${st.color};border:2px solid ${TH.surface};box-shadow:0 0 0 1px ${TH.muted}"></div>` });
        L.marker(pos, { icon }).bindTooltip(tip(l) + '<br>(line inside one area)', { className: 'tip' }).addTo(LINE_LAYER);
        nShown++;
      });
    }
  }
  const lineNote = !lsrc ? 'no line results for this day' : `${nShown} congested / heavily loaded lines${isRT && !lineRT ? ` (from DA ${pad(h)}:00; this RT file has no line flows)` : ''}`;
  $('#mapLegend').innerHTML =
    `<span>LMP ($/MWh) ${fmt(ctx.lo, 0)}<span class="grad" style="background:linear-gradient(90deg,${BLUE_RAMP.join(',')})"></span>${fmt(ctx.hi, 0)}</span>` +
    `<span><svg width="14" height="12" viewBox="0 0 16 16" style="vertical-align:-1px"><path d="M3 3.5 L10.5 8 L3 12.5 Z" fill="#8a8984" style="stroke:var(--surface-1,#fcfcfb);stroke-width:1.4;stroke-linejoin:round"/></svg> direction of flow</span>` +
    `<span>|shadow price| 0<span class="grad" style="background:linear-gradient(90deg,${ORANGE_RAMP.join(',')})"></span>${fmt(ctx.maxMu, 0)}</span>` +
    `<span>◆ line inside one area · grey dashed = loading ≥90% but not binding</span><span>${lineNote}${nUnk ? ` · ${nUnk} could not be located` : ''}</span>`;
  renderSidePanel(ctx, k, h, t);
}
function togglePlay() {
  if (S.playing) { stopPlay(); return; }
  $('#btnPlay').textContent = '⏸ Pause';
  const step = async () => {
    const sl = $('#mapSlider');
    S.mapIdx = (S.mapIdx + 1) % (+sl.max + 1); sl.value = S.mapIdx;
    await renderMapFrame(false);
  };
  S.playing = setInterval(step, S.stage === 'DA' ? 700 : 150);
}
function stopPlay() { if (S.playing) clearInterval(S.playing); S.playing = null; $('#btnPlay').textContent = '▶ Play'; }
function renderSidePanel(ctx, k, h, t) {
  const { main, da } = ctx, isRT = S.stage === 'RT';
  const i = S.mapArea, a = main.areas[i];
  const load = isRT ? (main.D ? main.D[k][i] : alignedLoad(a, t)) : main.D[h][i];
  const nodes = stageNodes(S.stage, a);
  const cp = nodes.length ? caisoAt(S.stage, nodes, t) : null;
  const panel = $('#sidePanel');
  if (!panel.querySelector('#sideGen')) {
    panel.innerHTML = '<h2 id="sideTitle"></h2><div class="kv" id="sideKV"></div><h3>LMP profile for the day</h3><div id="sidePrice" style="height:170px"></div><h3 id="sideGenTitle"></h3><div id="sideGen" style="height:260px"></div><p class="note" id="sideNote"></p>';
  }
  $('#sideTitle').textContent = a;
  const kv = [
    ['Time', t], ['LMP', `${fmt(main.lmp[k][i], 2)} $/MWh`], ['System SMP', `${fmt(main.smp[k], 2)} $/MWh`],
    [`CAISO ${S.stage}${nodes.length > 1 ? ` (mean of ${nodes.length} nodes)` : ''}`, nodes.length ? `${fmt(cp, 2)} $/MWh` : 'no matching node'],
    [isRT ? (main.D ? 'Load (5-min)' : 'Load (aligned hourly)') : 'Load D', `${fmt(load, 0)} MW`],
    ['Net injection', isRT ? (main.inj ? `${fmt(main.inj[k][i], 0)} MW` : '— (not in this RT file)') : `${fmt(main.inj[h][i], 0)} MW`],
    ['Load shed', `${fmt(main.shed[k][i], 1)} MW`],
  ];
  if (isRT) kv.push(['Over-generation', `${fmt(main.og[k][i], 1)} MW`]);
  if (!isRT && main.batP[i] > 0) { const s = main.storArea.indexOf(i); if (s >= 0) kv.push(['Storage discharge / charge', `${fmt(main.pd[h][s], 0)} / ${fmt(main.pc[h][s], 0)} MW`]); }
  $('#sideKV').innerHTML = kv.map(([x, y]) => `<div>${esc(x)}</div><div>${esc(y)}</div>`).join('');
  const x = Array.from({ length: main.T }, (_, q) => tstamp(S.stage, S.mapDay, q));
  const ptr = [{ type: 'scatter', mode: 'lines', name: 'Model', x, y: main.lmp.map((r) => r[i]), line: { color: C_MODEL, width: 2 } }];
  if (nodes.length) ptr.push({ type: 'scatter', mode: 'lines', name: 'CAISO', x, y: x.map((tt) => caisoAt(S.stage, nodes, tt)), line: { color: C_ACTUAL, width: 2 } });
  plot('sidePrice', ptr, { margin: { l: 40, r: 8, t: 24, b: 28 }, showlegend: nodes.length > 0, legend: { y: 1.0 }, xaxis: { tickformat: '%H:%M', nticks: 6 }, yaxis: { title: '' }, shapes: [{ type: 'line', x0: t, x1: t, yref: 'paper', y0: 0, y1: 1, line: { color: TH.ink, width: 1, dash: 'dot' } }] });
  if (!isRT) {
    const fuels = main.fuels, v = main.genAreaFuel[h][i];
    $('#sideGenTitle').textContent = `Generation by fuel ${pad(h)}:00 (MW)`;
    plot('sideGen', [{ type: 'bar', orientation: 'h', y: fuels.map((f) => FUEL_ZH[f] || f), x: v, marker: { color: fuels.map((f) => FUEL_COLOR[f]) }, hovertemplate: '%{y}: %{x:.0f} MW<extra></extra>' }],
      { margin: { l: 70, r: 12, t: 6, b: 28 }, hovermode: 'closest', yaxis: { autorange: 'reversed' }, xaxis: { rangemode: 'tozero' } });
    $('#sideNote').textContent = `Total ${fmt(sum(v), 0)} MW. Area generation by fuel = block output p summed by Uarea/Ufuel.`;
  } else {
    $('#sideGenTitle').textContent = 'Hydro output (MW, 5-min, this day)';
    plot('sideGen', [{ type: 'scatter', mode: 'lines', x, y: main.hydroArea.map((r) => r[i]), line: { color: FUEL_COLOR.Hydro, width: 2 }, name: 'Hydro' }],
      { margin: { l: 44, r: 8, t: 6, b: 28 }, showlegend: false, xaxis: { tickformat: '%H:%M' }, shapes: [{ type: 'line', x0: t, x1: t, yref: 'paper', y0: 0, y1: 1, line: { color: TH.ink, width: 1, dash: 'dot' } }] });
    $('#sideNote').textContent = 'RT results have no area-by-fuel output, only area hydro; see the Dispatch page for system totals by fuel.';
  }
}

// ------------------------------------------------------------------ prices
function fillPriceSelects() {
  const areas = S.geo.areas;
  const sel = $('#prArea');
  if (!sel.options.length) {
    sel.innerHTML = areas.map((a) => `<option value="${esc(a)}">${esc(a)}${(S.act.areaNodes[a] || []).length ? '' : ' (no CAISO match)'}</option>`).join('');
    sel.value = S.priceArea;
  }
  fillNodeSelect();
}
function fillNodeSelect() {
  const st = S.stage, src = st === 'DA' ? S.act.caisoDA : S.act.caisoRT;
  const mapped = stageNodes(st, S.priceArea);
  const prev = $('#prNode').dataset.stage === st && $('#prNode').dataset.area === S.priceArea ? $('#prNode').value : '__map__';
  const lbl = mapped.length ? (mapped.length > 1 ? `mapping: mean of ${mapped.length} nodes` : `mapping: ${mapped[0]}`) : 'mapping: none';
  $('#prNode').innerHTML = `<option value="__map__">${esc(lbl)}</option>` + Object.keys(src.nodes).map((n) => `<option>${esc(n)}</option>`).join('');
  $('#prNode').dataset.stage = st; $('#prNode').dataset.area = S.priceArea;
  $('#prNode').value = Array.from($('#prNode').options).some((o) => o.value === prev) ? prev : '__map__';
}
function pairStats(m, c) {
  const pr = []; for (let i = 0; i < m.length; i++) if (m[i] !== null && c[i] !== null && c[i] !== undefined) pr.push([m[i], c[i]]);
  const n = pr.length; if (!n) return null;
  const mm = mean(pr.map((p) => p[0])), cm = mean(pr.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0, ae = 0, se = 0;
  for (const [a, b] of pr) { sxy += (a - mm) * (b - cm); sxx += (a - mm) ** 2; syy += (b - cm) ** 2; ae += Math.abs(a - b); se += (a - b) ** 2; }
  return { n, mm, cm, bias: mm - cm, mae: ae / n, rmse: Math.sqrt(se / n), corr: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null };
}
function hourly(x, y) {
  const acc = new Map();
  x.forEach((t, i) => { const k = t.slice(0, 13); if (!acc.has(k)) acc.set(k, []); acc.get(k).push(y[i]); });
  return Array.from(acc.values()).map((v) => (v.some((z) => z === null || z === undefined) ? null : mean(v)));
}
async function renderPrices() {
  fillPriceSelects();
  const st = S.stage, a = S.priceArea;
  const days = await loadDays(st);
  if (!days.length) { emptyChart('chPrice', 'no data for the selected dates'); return; }
  const ai = days[0].j.areas.indexOf(a);
  const x = times(days, st), y = series(days, 'lmp', ai);
  const nodeSel = $('#prNode').value;
  const nodes = nodeSel === '__map__' ? stageNodes(st, a) : [nodeSel];
  const cy = nodes.length ? x.map((t) => caisoAt(st, nodes, t)) : [];
  const nodeLbl = nodes.length === 0 ? 'none' : nodes.length === 1 ? nodes[0] : `mean of ${nodes.length} nodes`;
  let note = '';
  if (!nodes.length) note = st === 'DA' && (S.act.areaNodes[a] || []).length ? 'This area has only WEIM RT nodes; the CAISO DA market has no matching price. Switch to RT or pick a node manually.' : 'This area has no matching CAISO node; pick a node manually to compare.';
  if (S.act.areaNodesMissing[a] && nodeSel === '__map__') note += ` Mapped nodes missing: ${S.act.areaNodesMissing[a].join(', ')}.`;
  $('#prNote').textContent = note;
  $('#prTitle').innerHTML = `${esc(a)} · ${st === 'DA' ? 'DA hourly' : 'RT 5-min'} LMP <span class="muted small">$/MWh, CAISO: ${esc(nodeLbl)}</span>`;
  const tr = [{ type: 'scatter', mode: 'lines', name: `Model ${st}`, x, y, line: { color: C_MODEL, width: st === 'RT' ? 1.5 : 2 }, hovertemplate: '%{y:.2f}' }];
  if (nodes.length) tr.push({ type: 'scatter', mode: 'lines', name: `CAISO ${st}`, x, y: cy, line: { color: C_ACTUAL, width: st === 'RT' ? 1.5 : 2 }, hovertemplate: '%{y:.2f}' });
  plot('chPrice', tr, { yaxis: { title: '$/MWh' }, xaxis: { rangeslider: { visible: days.length > 1, thickness: 0.06 } } });

  const stt = nodes.length ? pairStats(y, cy) : null;
  if (stt) {
    const lo = Math.min(...y.filter(Number.isFinite), ...cy.filter(Number.isFinite)), hi = Math.max(...y.filter(Number.isFinite), ...cy.filter(Number.isFinite));
    plot('chScatter', [
      { type: 'scatter', mode: 'markers', name: 'Interval', x: cy, y, marker: { color: C_MODEL, size: st === 'RT' ? 5 : 8, opacity: st === 'RT' ? 0.35 : 0.7, line: { color: TH.surface, width: st === 'RT' ? 0 : 1 } }, hovertemplate: 'CAISO %{x:.1f}<br>Model %{y:.1f}<extra></extra>' },
      { type: 'scatter', mode: 'lines', name: 'y = x', x: [lo, hi], y: [lo, hi], line: { color: TH.muted, width: 1, dash: 'dash' }, hoverinfo: 'skip' },
    ], { hovermode: 'closest', showlegend: false, xaxis: { title: `CAISO ${st} ($/MWh)` }, yaxis: { title: `Model ${st} ($/MWh)` } });
    const rows = [['Samples', stt.n, 0], ['Model mean', stt.mm, 2], ['CAISO mean', stt.cm, 2], ['Bias (model − CAISO)', stt.bias, 2], ['MAE', stt.mae, 2], ['RMSE', stt.rmse, 2], ['Correlation', stt.corr, 3]];
    if (st === 'RT') {
      const hs = pairStats(hourly(x, y), hourly(x, cy));
      if (hs) rows.push(['MAE of hourly means', hs.mae, 2], ['Correlation of hourly means', hs.corr, 3]);
    }
    $('#tblPriceStats').innerHTML = `<tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1] === stt.bias ? sgn(r[1], 2) : fmt(r[1], r[2])}</td></tr>`).join('')}</tbody>`;
  } else {
    emptyChart('chScatter', 'no CAISO price to compare');
    $('#tblPriceStats').innerHTML = '<tbody><tr><td>no data to compare</td><td></td></tr></tbody>';
  }
  // all areas
  const all = S.geo.areas.map((ar) => {
    const ns = stageNodes(st, ar);
    const yy = series(days, 'lmp', days[0].j.areas.indexOf(ar));
    if (!ns.length) return { ar, mm: mean(yy), s: null };
    return { ar, mm: mean(yy), s: pairStats(yy, x.map((t) => caisoAt(st, ns, t))) };
  });
  $('#tblPriceAll').innerHTML = `<thead><tr><th class="l">Area</th><th>Model mean</th><th>CAISO mean</th><th>Bias</th><th>MAE</th><th>Corr</th></tr></thead><tbody>${all.map((r) => `<tr class="${r.ar === a ? 'sel' : ''}"><td class="l"><span class="link" data-a="${esc(r.ar)}">${esc(r.ar)}</span></td><td>${fmt(r.mm, 1)}</td><td>${fmt(r.s?.cm, 1)}</td><td>${r.s ? sgn(r.s.bias, 1) : '—'}</td><td>${fmt(r.s?.mae, 1)}</td><td>${fmt(r.s?.corr, 2)}</td></tr>`).join('')}</tbody>`;
  $$('#tblPriceAll .link').forEach((el) => el.addEventListener('click', () => { S.priceArea = el.dataset.a; $('#prArea').value = S.priceArea; fillNodeSelect(); renderPrices(); }));
}

// ------------------------------------------------------------------ dispatch
const EIA_FUELS = [ // [label, color key, EIA columns]
  ['Nuclear', 'Nuclear', ['nuclear']], ['Coal', 'Coal', ['coal']], ['Geothermal', 'Geothermal', ['geothermal']], ['Gas (incl. oil)', 'Gas', ['gas', 'oil']],
  ['Hydro', 'Hydro', ['hydro']], ['Wind', 'Wind', ['wind']], ['Solar', 'Solar', ['solar']], ['Other (incl. pumped / other storage)', 'Other', ['other', 'psh', 'storage_other']],
];
const FUEL_CMP = { // model fuel -> EIA columns
  Nuclear: [['Nuclear'], ['nuclear']], Coal: [['Coal'], ['coal']], Geothermal: [['Geothermal'], ['geothermal']], Gas: [['Gas', 'Peaker'], ['gas', 'oil']],
  Hydro: [['Hydro'], ['hydro']], Wind: [['Wind'], ['wind']], Solar: [['Solar'], ['solar']], Biomass: [['Biomass'], ['other']],
};
const FUEL_CMP_ZH = { Nuclear: 'Nuclear', Coal: 'Coal', Geothermal: 'Geothermal', Gas: 'Gas + peaker vs EIA gas + oil', Hydro: 'Hydro', Wind: 'Wind', Solar: 'Solar', Biomass: 'Biomass vs EIA other' };
function eiaSeries(dates, cols, area) {
  const e = S.act.eia, src = area ? e.areas[area] : e.system;
  const x = [], y = [];
  for (const d of dates) for (let h = 0; h < 24; h++) {
    const t = `${d} ${pad(h)}:00`, k = S.act.idx.eia.get(t);
    x.push(t);
    y.push(k === undefined ? null : cols.reduce((s, c) => (src[c][k] === null ? s : s + src[c][k]), 0));
  }
  return { x, y };
}
async function renderDispatch() {
  const st = S.stage;
  const days = await loadDays(st);
  if (!days.length) { emptyChart('chGenModel', 'no data for the selected dates'); return; }
  const x = times(days, st), fuels = days[0].j.fuels, dates = days.map((d) => d.date);
  $('#dsTitle').innerHTML = `Model ${st} generation (by fuel) <span class="muted small">MW${st === 'RT' ? ', 5-min' : ''}</span>`;
  const stackTr = (xx, name, y, color) => ({ type: 'scatter', mode: 'lines', stackgroup: 'g', name, x: xx, y, line: { width: 0.5, color: TH.surface }, fillcolor: color, hovertemplate: '%{y:,.0f}' });
  const mtr = fuels.map((f, i) => stackTr(x, FUEL_ZH[f] || f, series(days, 'genFuel', i), FUEL_COLOR[f]));
  const disch = x.map((_, q) => 0);
  let qi = 0;
  for (const { j } of days) for (let k = 0; k < j.T; k++, qi++) disch[qi] = Math.max(0, rowSum(j.pd[k]) - rowSum(j.pc[k]));
  mtr.push(stackTr(x, 'Storage net discharge', disch, FUEL_COLOR.Storage));
  let loadY;
  if (st === 'DA') loadY = series(days, 'D').map(rowSum);
  else loadY = x.map((t) => sum(S.geo.areas.map((a) => alignedLoad(a, t))));
  mtr.push({ type: 'scatter', mode: 'lines', name: st === 'DA' ? 'Load D' : 'Load (aligned hourly)', x, y: loadY, line: { color: TH.ink, width: 1.5, dash: 'dot' }, hovertemplate: '%{y:,.0f}' });
  const eX = eiaSeries(dates, ['demand']).x;
  const etr = EIA_FUELS.map(([lbl, ck, cols]) => stackTr(eX, lbl, eiaSeries(dates, cols).y, FUEL_COLOR[ck]));
  etr.push(stackTr(eX, 'Battery net discharge', eiaSeries(dates, ['battery']).y.map((v) => Math.max(0, v || 0)), FUEL_COLOR.Storage));
  etr.push({ type: 'scatter', mode: 'lines', name: 'EIA demand', x: eX, y: eiaSeries(dates, ['demand']).y, line: { color: TH.ink, width: 1.5, dash: 'dot' }, hovertemplate: '%{y:,.0f}' });
  const ymax = 1.05 * Math.max(...loadY.filter(Number.isFinite), ...eiaSeries(dates, ['demand']).y.filter(Number.isFinite), ...x.map((_, q) => sum(fuels.map((f, i) => mtr[i].y[q])) + disch[q]));
  const lay = { yaxis: { title: 'MW', range: [0, ymax] }, legend: { font: { size: 11 } }, margin: { t: 60 } };
  plot('chGenModel', mtr, lay);
  plot('chGenEia', etr, lay);

  // fuel compare
  const fs = $('#dsFuel');
  if (!fs.options.length) { fs.innerHTML = Object.keys(FUEL_CMP).map((f) => `<option value="${f}">${FUEL_CMP_ZH[f]}</option>`).join(''); fs.value = 'Gas'; }
  const [mf, ec] = FUEL_CMP[fs.value];
  const my = x.map((_, q) => 0);
  mf.forEach((f) => { const i = fuels.indexOf(f); series(days, 'genFuel', i).forEach((v, q) => { my[q] += v || 0; }); });
  const ey = eiaSeries(dates, ec);
  plot('chFuelCmp', [
    { type: 'scatter', mode: 'lines', name: `Model ${st}`, x, y: my, line: { color: C_MODEL, width: 2 }, hovertemplate: '%{y:,.0f}' },
    { type: 'scatter', mode: 'lines', name: 'EIA-930', x: ey.x, y: ey.y, line: { color: C_ACTUAL, width: 2 }, hovertemplate: '%{y:,.0f}' },
  ], { yaxis: { title: 'MW', rangemode: 'tozero' } });
  const dt = st === 'DA' ? 1 : 1 / 12;
  $('#tblEnergy').innerHTML = `<thead><tr><th class="l">Fuel</th><th>Model GWh</th><th>EIA GWh</th><th>Diff</th></tr></thead><tbody>${Object.entries(FUEL_CMP).map(([k, [m, e]]) => {
    let mg = 0; m.forEach((f) => { const i = fuels.indexOf(f); mg += sum(series(days, 'genFuel', i)) * dt / 1000; });
    const eg = sum(eiaSeries(dates, e).y) / 1000;
    return `<tr><td class="l">${FUEL_CMP_ZH[k]}</td><td>${fmt(mg, 0)}</td><td>${fmt(eg, 0)}</td><td>${eg ? sgn((mg - eg) / eg * 100, 1) + '%' : '—'}</td></tr>`;
  }).join('')}</tbody><caption style="caption-side:bottom;text-align:left" class="muted small">EIA-930 is the sum of U.S. WECC balancing areas (incl. OTHER_WECC), so its footprint differs slightly from the 19 model areas.</caption>`;

  // storage
  const j0 = days[0].j;
  let storIdx = j0.storArea;
  if (!storIdx && vinfo().DA.length) storIdx = (await getJSON(dayUrl(S.variant, vinfo().DA[0], 'DA'))).storArea;
  storIdx = Array.isArray(storIdx) ? storIdx : (storIdx === undefined || storIdx === null ? [] : [storIdx]);
  const storAreas = storIdx.map((i) => j0.areas[i]);
  const ss = $('#dsStor');
  const want = `<option value="-1">All storage (${storAreas.length})</option>` + storAreas.map((a, s) => `<option value="${s}">${esc(a)}</option>`).join('');
  if (ss.dataset.sig !== want) { const prev = ss.value; ss.innerHTML = want; ss.dataset.sig = want; ss.value = Array.from(ss.options).some((o) => o.value === prev) ? prev : '-1'; }
  const s = +ss.value;
  const pick = (field) => series(days, field).map((r) => (s < 0 ? rowSum(r) : (Array.isArray(r) ? r[s] : r)));
  const pd = pick('pd'), pc = pick('pc'), e = pick('e');
  const str = [
    { type: 'bar', name: 'Discharge', x, y: pd, marker: { color: C_MODEL }, hovertemplate: '%{y:,.0f}' },
    { type: 'bar', name: 'Charge', x, y: pc.map((v) => -v), marker: { color: C_ACTUAL }, hovertemplate: '%{y:,.0f}' },
  ];
  if (s < 0) str.push({ type: 'scatter', mode: 'lines', name: 'EIA battery net output', x: eX, y: eiaSeries(dates, ['battery']).y, line: { color: TH.ink, width: 1.5, dash: 'dot' }, hovertemplate: '%{y:,.0f}' });
  plot('chStorP', str, { barmode: 'relative', bargap: 0.1, yaxis: { title: 'MW' }, margin: { t: 30, b: 30 } });
  plot('chStorE', [{ type: 'scatter', mode: 'lines', name: 'SOC', x, y: e, line: { color: C_THIRD, width: 2 }, fill: 'tozeroy', fillcolor: 'rgba(27,175,122,0.12)', hovertemplate: '%{y:,.0f} MWh' }],
    { showlegend: false, yaxis: { title: 'SOC MWh', rangemode: 'tozero' }, margin: { t: 10, b: 30 } });

  // hydro heatmap
  const areas = j0.areas;
  const z = areas.map((_, a) => series(days, 'hydroArea', a));
  const order = areas.map((a, i) => [a, sum(z[i])]).sort((p, q) => p[1] - q[1]).map((p) => areas.indexOf(p[0])).filter((i) => sum(z[i]) > 0);
  plot('chHydro', [{ type: 'heatmap', x, y: order.map((i) => areas[i]), z: order.map((i) => z[i]), colorscale: BLUE_RAMP.map((c, i) => [i / (BLUE_RAMP.length - 1), c]), colorbar: { title: { text: 'MW' }, thickness: 12 }, hovertemplate: '%{y}<br>%{x}<br>%{z:,.0f} MW<extra></extra>' }],
    { hovermode: 'closest', margin: { l: 120 }, yaxis: { automargin: true } });
}

// ------------------------------------------------------------------ congestion
let CG = null;
async function renderCongestion() {
  let cst = 'DA', ds = stageDates('DA'), days = await loadDays('DA', ds);
  if (S.stage === 'RT') {                                    // RT files from R3 on carry 5-min line flows
    const rds = stageDates('RT'), rdays = await loadDays('RT', rds);
    if (rdays.length && rdays.every(({ j }) => Array.isArray(j.lines))) { cst = 'RT'; ds = rds; days = rdays; }
  }
  const per = cst === 'RT' ? 12 : 1;                         // intervals per hour
  const agg = new Map();
  const nTot = days.length ? Math.max(...days.map((d) => d.j.nLines)) : 0;
  days.forEach(({ date, j }, di) => {
    for (const l of j.lines) {
      const key = lineKey(l);
      if (!agg.has(key)) agg.set(key, { name: key, bus: l.bus, Flim: l.Flim, bindH: 0, limH: 0, maxMu: 0, rent: 0, sumMu: 0, maxLd: 0, days: new Map() });
      const r = agg.get(key);
      r.Flim = Math.max(r.Flim, l.Flim);
      r.days.set(date, l);
      l.mu.forEach((m, h) => {
        const am = Math.abs(m), af = Math.abs(l.flow[h]);
        if (am > BIND_EPS) r.bindH += 1 / per;
        if (l.Flim && af >= 0.99 * l.Flim) r.limH += 1 / per;
        r.maxMu = Math.max(r.maxMu, am); r.rent += am * af / per; r.sumMu += am;
        if (l.Flim) r.maxLd = Math.max(r.maxLd, af / l.Flim);
      });
    }
  });
  CG = { rows: Array.from(agg.values()), dates: ds, days, cst, per };
  for (const r of CG.rows) { const g = S.geo.lines[r.name]; r.areas = g ? (g.f === g.t ? shortArea(g.f) + ' (internal)' : `${shortArea(g.f)} → ${shortArea(g.t)}`) : 'not located'; }
  $('#cgNote').textContent = `${ds.length} days · each day exports only lines with a shadow price or loading ≥90% (about ${nTot} lines in the network). Showing ${cst} results${cst === 'RT' ? ' (5-min; hours = intervals / 12)' : ''}.${S.stage === 'RT' && cst === 'DA' ? ' RT files of this variant have no line flows, so DA is shown.' : ''}`;
  renderCongestionTable();
  if (S.cgSel && agg.has(S.cgSel)) renderLineChart(S.cgSel); else { emptyChart('chLineFlow', 'click a line in the table above'); emptyChart('chLineMu', ''); }
}
function renderCongestionTable() {
  if (!CG) return;
  const q = $('#cgSearch').value.trim().toLowerCase(), only = $('#cgOnlyBind').checked;
  const cols = [['name', 'Line', 'l'], ['bus', 'Buses', 'l'], ['areas', 'Areas', 'l'], ['Flim', 'Limit MW', 0], ['bindH', 'Binding hours', 0], ['limH', 'Hours at limit (≥99%)', 0], ['maxLd', 'Max loading', 'pct'], ['maxMu', 'Max |shadow price| $/MWh', 2], ['rent', 'Congestion rent Σ|μ|·|F| k$', 'k']];
  const { key, dir } = S.cgSort;
  let rows = CG.rows.filter((r) => (!only || r.bindH > 0) && (!q || `${r.name} ${r.bus} ${r.areas}`.toLowerCase().includes(q)));
  rows.sort((a, b) => (typeof a[key] === 'string' ? a[key].localeCompare(b[key]) : a[key] - b[key]) * dir);
  const cell = (r, c) => c[2] === 'l' ? `<td class="l">${esc(r[c[0]])}</td>` : c[2] === 'pct' ? `<td>${fmt(r[c[0]] * 100, 0)}%</td>` : c[2] === 'k' ? `<td>${fmt(r[c[0]] / 1000, 1)}</td>` : `<td>${fmt(r[c[0]], c[2])}</td>`;
  $('#tblLines').innerHTML = `<thead><tr>${cols.map((c) => `<th class="sortable ${c[2] === 'l' ? 'l' : ''}" data-k="${c[0]}">${c[1]}${key === c[0] ? (dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr data-n="${esc(r.name)}" class="${r.name === S.cgSel ? 'sel' : ''}">${cols.map((c) => cell(r, c)).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="empty">no matching lines</td></tr>`}</tbody>`;
  $$('#tblLines th.sortable').forEach((th) => th.addEventListener('click', () => { const k = th.dataset.k; S.cgSort = { key: k, dir: S.cgSort.key === k ? -S.cgSort.dir : -1 }; renderCongestionTable(); }));
  $$('#tblLines tbody tr[data-n]').forEach((tr) => tr.addEventListener('click', () => { S.cgSel = tr.dataset.n; $$('#tblLines tbody tr').forEach((x) => x.classList.toggle('sel', x === tr)); renderLineChart(S.cgSel); }));
}
function renderLineChart(name) {
  const r = CG.rows.find((x) => x.name === name); if (!r) return;
  const x = [], f = [], mu = [], lim = [];
  for (const d of CG.dates) {
    const l = r.days.get(d);
    const nq = CG.cst === 'RT' ? 288 : 24;
    for (let q = 0; q < nq; q++) { x.push(tstamp(CG.cst, d, q)); f.push(l ? l.flow[q] : null); mu.push(l ? l.mu[q] : null); lim.push(l ? l.Flim : null); }
  }
  $('#cgTitle').innerHTML = `${esc(r.name)} <span class="muted small">${esc(r.bus)} · ${esc(r.areas)} · gaps = not exported that day (not binding and loading &lt;90%)</span>`;
  plot('chLineFlow', [
    { type: 'scatter', mode: 'lines', name: `${CG.cst} flow`, x, y: f, line: { color: C_MODEL, width: 2 }, hovertemplate: '%{y:,.0f} MW' },
    { type: 'scatter', mode: 'lines', name: '+limit', x, y: lim, line: { color: TH.text2, width: 1.5, dash: 'dash' }, hovertemplate: '%{y:,.0f}' },
    { type: 'scatter', mode: 'lines', name: '−limit', x, y: lim.map((v) => (v === null ? null : -v)), line: { color: TH.text2, width: 1.5, dash: 'dash' }, hovertemplate: '%{y:,.0f}' },
  ], { yaxis: { title: 'Flow MW' } });
  plot('chLineMu', [{ type: 'bar', name: 'Shadow price μ', x, y: mu, marker: { color: C_ACTUAL }, hovertemplate: '%{y:.2f} $/MWh' }], { yaxis: { title: 'μ $/MWh' }, showlegend: false, margin: { t: 10 } });
}

// ------------------------------------------------------------------ load
let LMAP = null, LMAP_LAYER = null;
async function renderLoad() {
  const days = await loadDays('DA', stageDates('DA'));
  if (!days.length) { emptyChart('chLoadBar', 'no DA data for the selected dates'); return; }
  const areas = days[0].j.areas, stat = $('#ldStat').value;
  const vals = areas.map((_, a) => {
    const y = series(days, 'D', a);
    return stat === 'mean' ? mean(y) : stat === 'peak' ? Math.max(...y) : sum(y) / 1000;
  });
  const unit = stat === 'energy' ? 'GWh' : 'MW';
  const ord = areas.map((a, i) => i).sort((p, q) => vals[p] - vals[q]);
  plot('chLoadBar', [{ type: 'bar', orientation: 'h', y: ord.map((i) => areas[i]), x: ord.map((i) => vals[i]), marker: { color: C_MODEL }, hovertemplate: `%{y}: %{x:,.0f} ${unit}<extra></extra>` }],
    { hovermode: 'closest', margin: { l: 120, t: 10 }, xaxis: { title: `Model DA load D (${unit})` } });
  // mini map
  if (!LMAP) {
    LMAP = L.map('loadMap', { zoomSnap: 0.25, minZoom: 3, maxZoom: 9 });
    LMAP.createPane('states'); LMAP.getPane('states').style.zIndex = 250;
    statesLayer(LMAP, 'states');
    LMAP_LAYER = L.layerGroup().addTo(LMAP);
  }
  await nextFrame(); LMAP.invalidateSize();
  if (!LMAP._fitted) { LMAP.fitBounds(WECC_BOUNDS); LMAP._fitted = true; }
  LMAP_LAYER.clearLayers();
  const vmax = Math.max(...vals);
  areas.forEach((a, i) => {
    const c = S.geo.centroids[a];
    L.circleMarker([c.lat, c.lon], { radius: 4 + 26 * Math.sqrt(vals[i] / vmax), color: TH.surface, weight: 2, fillColor: C_MODEL, fillOpacity: 0.75 })
      .bindTooltip(`<b>${esc(a)}</b><br>${fmt(vals[i], 0)} ${unit}`, { className: 'tip' })
      .on('click', () => { S.loadArea = a; $('#ldArea').value = a; renderLoad(); })
      .addTo(LMAP_LAYER);
  });
  // time series
  const sel = $('#ldArea');
  if (!sel.options.length) {
    sel.innerHTML = '<option value="__sys__">WECC model, 19-area total</option><option value="__ca__">California total (22+24+30)</option>' + areas.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    sel.value = S.loadArea;
  }
  const A = S.loadArea;
  const idx = A === '__sys__' ? areas.map((_, i) => i) : A === '__ca__' ? CA_AREAS.map((a) => areas.indexOf(a)) : [areas.indexOf(A)];
  const x = times(days, 'DA');
  const dm = x.map((_, q) => 0);
  idx.forEach((i) => series(days, 'D', i).forEach((v, q) => { dm[q] += v || 0; }));
  const al = x.map((t) => sum(idx.map((i) => alignedLoad(areas[i], t))));
  const dates = days.map((d) => d.date);
  let eiaArea = null, note = '';
  if (A === '__ca__') eiaArea = 'CAISO(22+24+30)';
  else if (A === '__sys__') note = 'EIA is the sum of 18 BA groups (excl. OTHER_WECC).';
  else if (CA_AREAS.includes(A)) note = 'EIA-930 reports only the CAISO total, so a single California area has no actual demand to compare; choose "California total".';
  else if (S.act.eia.areas[A]) eiaArea = A;
  let ed = null, edf = null;
  if (A === '__sys__') {
    const keys = Object.keys(S.act.eia.areas).filter((k) => k !== 'OTHER_WECC');
    const ex = eiaSeries(dates, ['demand']).x;
    ed = { x: ex, y: ex.map((t) => { const k = S.act.idx.eia.get(t); return k === undefined ? null : sum(keys.map((a) => S.act.eia.areas[a].demand[k])); }) };
    edf = { x: ex, y: ex.map((t) => { const k = S.act.idx.eia.get(t); return k === undefined ? null : sum(keys.map((a) => S.act.eia.areas[a].DF[k])); }) };
  } else if (eiaArea) { ed = eiaSeries(dates, ['demand'], eiaArea); edf = eiaSeries(dates, ['DF'], eiaArea); }
  $('#ldNote').textContent = note + ' "Aligned load" = data_derived/aligned/load_MDT.csv (RT input).';
  const tr = [
    { type: 'scatter', mode: 'lines', name: 'Model DA load D', x, y: dm, line: { color: C_MODEL, width: 2 }, hovertemplate: '%{y:,.0f}' },
    { type: 'scatter', mode: 'lines', name: 'Aligned load', x, y: al, line: { color: C_THIRD, width: 2, dash: 'dot' }, hovertemplate: '%{y:,.0f}' },
  ];
  if (ed) {
    tr.push({ type: 'scatter', mode: 'lines', name: 'EIA actual demand', x: ed.x, y: ed.y, line: { color: C_ACTUAL, width: 2 }, hovertemplate: '%{y:,.0f}' });
    tr.push({ type: 'scatter', mode: 'lines', name: 'EIA day-ahead forecast', x: edf.x, y: edf.y, line: { color: TH.muted, width: 1.5, dash: 'dash' }, hovertemplate: '%{y:,.0f}' });
  }
  plot('chLoadTs', tr, { yaxis: { title: 'MW' } });
  const st = [['Energy GWh', sum(dm) / 1000, sum(al) / 1000, ed ? sum(ed.y) / 1000 : null], ['Peak MW', Math.max(...dm), Math.max(...al), ed ? Math.max(...ed.y.filter(Number.isFinite)) : null]];
  const ps = ed ? pairStats(dm, ed.y) : null;
  let mape = null;
  if (ed) { const e = []; dm.forEach((v, i) => { if (ed.y[i]) e.push(Math.abs(v - ed.y[i]) / ed.y[i]); }); mape = mean(e) * 100; }
  $('#tblLoadStats').innerHTML = `<thead><tr><th class="l"></th><th>Model D</th><th>Aligned load</th><th>EIA actual</th></tr></thead><tbody>${st.map((r) => `<tr><td class="l">${r[0]}</td><td>${fmt(r[1], 0)}</td><td>${fmt(r[2], 0)}</td><td>${fmt(r[3], 0)}</td></tr>`).join('')}` +
    (ps ? `<tr><td class="l">Model D vs EIA: MAPE / corr</td><td colspan="3">${fmt(mape, 1)}% / ${fmt(ps.corr, 3)}</td></tr>` : '') + '</tbody>';
}

// ------------------------------------------------------------------ run
const runMode = () => (document.querySelector('input[name="mode"]:checked') || {}).value || 'DA';
async function refreshRunView() {
  const vr = await getJSON('/api/variants?t=' + Date.now());
  applyVariants(vr);
  const names = Array.from(new Set([...S.folders, ...S.variants.map((v) => v.name)])).sort();
  $('#runVariantList').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
  if (!$('#runVariant').value) $('#runVariant').value = S.variant || '';
  $('#tblFound').innerHTML = `<thead><tr><th class="l">Variant</th><th>DA days (JSON/mat)</th><th>RT days (JSON/mat)</th><th>To export</th><th class="l">Log</th></tr></thead><tbody>${S.variants.map((v) =>
    `<tr><td class="l">${esc(v.name)}</td><td>${v.DA.length}/${v.matDA.length}</td><td>${v.RT.length}/${v.matRT.length}</td><td>${v.stale || 0}</td><td class="l"><span class="link" data-v="${esc(v.name)}" data-m="DA">DA</span> · <span class="link" data-v="${esc(v.name)}" data-m="DART">DART</span></td></tr>`).join('')}</tbody>`;
  $$('#tblFound .link').forEach((el) => el.addEventListener('click', () => { $('#runVariant').value = el.dataset.v; const r = document.querySelector(`input[name="mode"][value="${el.dataset.m}"]`); if (r) r.checked = true; startPolling(el.dataset.v, el.dataset.m); }));
  if (!S.runKey) { const v = vinfo(); startPolling(S.variant, v.RT.length ? 'DART' : 'DA'); }
}
async function submitRun(ev) {
  ev.preventDefault();
  const v = $('#runVariant').value.trim(), mode = runMode();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(v)) { toast('Variant name may contain only letters, digits, underscore and hyphen'); return; }
  if (!confirm(`Start a model run?\n\npython matlab/run_batch.py ${mode} ${v}\n\nDA takes a few minutes, DART about 1.5–2.5 h. Existing results and logs in results_week/${v}/ will be overwritten.`)) return;
  try {
    const r = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variant: v, mode }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    toast(`Started ${j.key} (PID ${j.pid})`);
    startPolling(v, mode);
  } catch (e) { toast('Start failed: ' + e.message, 8000); }
}
async function manualExport() {
  const v = $('#runVariant').value.trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(v)) { toast('Enter a variant name'); return; }
  const b = $('#btnExport'); b.disabled = true; b.textContent = 'Exporting… (about 30 s)';
  try {
    const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variant: v }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    $('#exportLog').textContent = j.log.join('\n');
    clearVariantCache(v); cache.delete('/api/geo');
    await afterDataChange();
    toast(`Export finished rc=${j.rc}`);
  } catch (e) { toast('Export failed: ' + e.message, 8000); } finally { b.disabled = false; b.textContent = 'Export JSON only'; }
}
async function afterDataChange() {
  const vr = await getJSON('/api/variants?t=' + Date.now());
  applyVariants(vr);
  const cur = S.variant;
  S.variant = S.variants.some((v) => v.name === cur) ? cur : S.variants[0]?.name;
  const [st, en] = [S.start, S.end];
  fillGlobalSelects();
  if (S.dates.includes(st)) { S.start = st; $('#selStart').value = st; }
  if (S.dates.includes(en)) { S.end = en; $('#selEnd').value = en; }
  Object.keys(MAP_CTX).forEach((k) => delete MAP_CTX[k]);
  $$('#tabs button').forEach((b) => S.dirty.add(b.dataset.view));
  S.dirty.delete('run');
  refreshRunView();
}
function startPolling(v, mode) {
  S.runKey = `${v}_${mode}`;
  $('#runTitle').textContent = `Run log · results_week/logs/${S.runKey}.txt`;
  clearInterval(S.runTimer);
  let lastState = null;
  const poll = async () => {
    try {
      const r = await fetch(`/api/runlog?variant=${encodeURIComponent(v)}&mode=${mode}&n=400`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      if (S.runKey !== `${v}_${mode}`) return;
      const pre = $('#runLog'), atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
      pre.textContent = j.log.length ? j.log.join('\n') : (j.logExists ? '(log is empty)' : '(no log file yet)');
      if (atBottom) pre.scrollTop = pre.scrollHeight;
      const job = j.job;
      const stZh = { running: 'running', exporting: 'model finished, exporting JSON', done: 'done', failed: 'failed' };
      if (job) {
        const el = Math.round(job.elapsed);
        $('#runStatus').innerHTML = `<span class="state"><span class="dot ${job.state === 'exporting' ? 'running' : job.state}"></span>${stZh[job.state] || job.state}</span> · PID ${job.pid} · elapsed ${Math.floor(el / 60)} min ${pad(el % 60)} s${job.rc !== null ? ` · model rc=${job.rc}` : ''}${job.export_rc !== null ? ` · export rc=${job.export_rc}` : ''}`;
        $('#exportLog').textContent = [...(j.runner || []).map((l) => '[run_batch] ' + l), ...(j.export || [])].join('\n');
        if (lastState && lastState !== job.state && (job.state === 'done' || job.state === 'failed')) { clearVariantCache(v); cache.delete('/api/geo'); afterDataChange(); toast(`${S.runKey} ${stZh[job.state]}, data refreshed`, 8000); }
        lastState = job.state;
        if (job.state === 'done' || job.state === 'failed') { clearInterval(S.runTimer); }
      } else {
        const mt = j.logMtime ? new Date(j.logMtime * 1000).toLocaleString('en-US') : null;
        $('#runStatus').innerHTML = `<span class="state"><span class="dot"></span>not started from this dashboard</span>${mt ? ` · log last modified ${mt}` : ''}`;
        clearInterval(S.runTimer); S.runTimer = setInterval(poll, 10000);
      }
    } catch (e) { $('#runStatus').textContent = 'Failed to read log: ' + e.message; }
  };
  poll();
  S.runTimer = setInterval(poll, 3000);
}

function variantDates() { const i = vinfo(); return Array.from(new Set([...(i.DA || []), ...(i.RT || [])])).sort(); }
function setRangeToVariant() { const ds = variantDates(); if (ds.length) { S.start = ds[0]; S.end = ds[ds.length - 1]; } }
function fillDateSelects() {
  const opts = variantDates().map((d) => `<option>${d}</option>`).join('');
  $('#selStart').innerHTML = opts; $('#selEnd').innerHTML = opts;
  $('#selStart').value = S.start; $('#selEnd').value = S.end;
}
function CAISO_V5() {
  const suffix = (S.variant.match(/_(oct|may|jan)$/) || [''])[0];
  const row = (window.METRICS || []).find((r) => r.Row === 'CAISO' + suffix);
  return row ? fmt(row.mean_abs_5min_change, 2) : '—';
}
window.addEventListener('themechange', () => {
  if (STATES) STATES.setStyle({ color: TH.line, fillColor: TH.land });
  $$('#tabs button').forEach((b) => S.dirty.add(b.dataset.view));
  renderView(S.view);
});

document.addEventListener('DOMContentLoaded', init);
