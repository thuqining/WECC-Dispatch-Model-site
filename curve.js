/* Generator supply curve view for the hosted snapshot, loaded after app.js.
 *
 * Every generator block of the selected model on one day, sorted by price: the variable-cost
 * curve on the left, the offer curve (what the market clears on) on the right. R5 on the same
 * day is drawn dashed for comparison, and the table counts how much capacity sits at the top of
 * each curve, which is what decides how high the price can go when the system is tight.
 */
'use strict';

const CURVE_THRESHOLDS = [100, 200, 500, 800];
const dayKey = (d) => 'd' + d.replace(/-/g, '_');

function curveSteps(d, field) {
  const idx = d[field].map((_, i) => i).sort((a, b) => d[field][a] - d[field][b]);
  const xs = [0], ys = [], mids = [], blocks = [];
  let cum = 0;
  for (const i of idx) {
    const gw = d.mw[i] / 1000;
    mids.push(cum + gw / 2);
    cum += gw;
    xs.push(cum);
    ys.push(d[field][i]);
    blocks.push(i);
  }
  ys.push(ys[ys.length - 1]);
  return { xs, ys, mids, blocks };
}

function curveTraces(d, field, base) {
  const st = curveSteps(d, field);
  const traces = [{ type: 'scatter', mode: 'lines', x: st.xs, y: st.ys, line: { shape: 'hv', color: TH.text2, width: 1.4 },
    name: S.variant, hoverinfo: 'skip', showlegend: false }];
  const fuels = [...new Set(d.fuel)];
  for (const f of fuels) {
    const k = st.blocks.map((b, j) => [b, j]).filter(([b]) => d.fuel[b] === f);
    traces.push({
      type: 'scatter', mode: 'markers', name: FUEL_ZH[f] || f,
      x: k.map(([, j]) => st.mids[j]), y: k.map(([b]) => d[field][b]),
      marker: { color: FUEL_COLOR[f] || TH.muted, size: 8, line: { color: TH.surface, width: 1 } },
      customdata: k.map(([b]) => [d.area[b], d.mw[b], d.cost[b], d.offer[b]]),
      hovertemplate: `<b>${FUEL_ZH[f] || f}</b> %{customdata[0]}<br>%{customdata[1]:,.0f} MW<br>` +
        'cost $%{customdata[2]:.2f} · offer $%{customdata[3]:.2f}<extra></extra>',
    });
  }
  if (base) {
    const bs = curveSteps(base, field);
    traces.unshift({ type: 'scatter', mode: 'lines', x: bs.xs, y: bs.ys, name: 'R5 (same day)',
      line: { shape: 'hv', color: TH.muted, width: 1.2, dash: 'dash' }, hoverinfo: 'skip' });
  }
  return traces;
}

function tailRow(label, d) {
  const cells = [label];
  const gw = (m) => (d.mw.reduce((s, x, i) => s + (m(i) ? x : 0), 0)).toLocaleString(undefined, { maximumFractionDigits: 0 });
  for (const t of CURVE_THRESHOLDS) cells.push(gw((i) => d.offer[i] > t));
  cells.push(Math.max(...d.offer).toFixed(0));
  cells.push(gw((i) => d.offer[i] < 0));
  cells.push(Math.max(...d.cost).toFixed(0));
  return cells;
}

async function renderCurve() {
  const v = S.variant;
  let info;
  try { info = await getJSON(`/api/curve?variant=${encodeURIComponent(v)}`); } catch (e) { info = null; }
  if (!info || !info.dates) {
    emptyChart('chCurveCost', 'No supply curve published for this model');
    emptyChart('chCurveOffer', '');
    $('#tblCurve').innerHTML = '';
    return;
  }
  const sel = $('#cvDay');
  if (sel.dataset.v !== v) {
    sel.innerHTML = info.dates.map((d) => `<option>${d}</option>`).join('');
    sel.dataset.v = v;
    sel.value = selDates().find((d) => info.dates.includes(d)) || info.dates[0];
  }
  const day = sel.value;
  const d = info.days[dayKey(day)];
  const suffix = (v.match(/_(may|jan|oct)$/) || [''])[0];
  const baseName = 'R5' + suffix;
  let base = null;
  if (v !== baseName && !v.startsWith('M2_')) {          // model2 has no R5 baseline
    try { base = (await getJSON(`/api/curve?variant=${encodeURIComponent(baseName)}`)).days[dayKey(day)]; } catch (e) { base = null; }
  }
  const lay = (title) => ({ hovermode: 'closest', xaxis: { title: 'Cumulative capacity (GW)' },
    yaxis: { title, zeroline: true, zerolinecolor: TH.axis }, legend: { orientation: 'h', y: 1.02, yanchor: 'bottom' } });
  plot('chCurveCost', curveTraces(d, 'cost', base), lay('Variable cost ($/MWh)'));
  plot('chCurveOffer', curveTraces(d, 'offer', base), lay('Offer ($/MWh)'));
  const head = ['', ...CURVE_THRESHOLDS.map((t) => `MW offered > $${t}`), 'Top offer $/MWh', 'MW offered < $0', 'Top cost $/MWh'];
  const rows = [tailRow(v, d)];
  if (base) rows.push(tailRow(baseName, base));
  $('#tblCurve').innerHTML = `<thead><tr>${head.map((h, i) => `<th class="${i ? '' : 'l'}">${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? '' : 'l'}">${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
}
window.renderCurve = renderCurve;

document.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('cvDay');
  if (sel) sel.addEventListener('change', () => { if (S.view === 'curve') renderCurve(); });
});
