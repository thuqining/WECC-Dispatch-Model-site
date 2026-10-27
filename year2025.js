/* The 2025 out-of-sample year, loaded after app.js and registered with the router as view "year".
 *
 * The six 2025 weeks in the model selector carry full 5-minute detail for every other view; this one
 * carries all 53 weeks, summarised: model2 ran unchanged over the whole year (model2/, finalize_m2.sh) and
 * is scored here against CAISO's published prices, the average of the three California DLAPs.
 * Everything is read from data/year_2025.json, written by data_2025/export_year.py.
 */
'use strict';

const YEAR_URL = 'data/year_2025.json';
const REF_R38 = { da: 7.30, rt: 9.96, daCorr: 0.89, rtCorr: 0.73, neg: 5.2 };   // R38 over 2025, same scoring (yStats)
let YEAR = null;

const yFmt = (x, n = 2) => (x === null || x === undefined || Number.isNaN(x)) ? '–' : x.toFixed(n);

function yStats(model, caiso) {
  let n = 0, sae = 0, sm = 0, sc = 0, sm2 = 0, sc2 = 0, smc = 0, neg = 0, negC = 0;
  for (let i = 0; i < model.length; i++) {
    const a = model[i], b = caiso[i];
    if (a === null || b === null) continue;
    n++; sae += Math.abs(a - b); sm += a; sc += b; sm2 += a * a; sc2 += b * b; smc += a * b;
    if (a < 0) neg++;
    if (b < 0) negC++;
  }
  const mm = sm / n, mc = sc / n, vm = sm2 / n - mm * mm, vc = sc2 / n - mc * mc;
  return { n, mae: sae / n, model: mm, caiso: mc, corr: (smc / n - mm * mc) / Math.sqrt(vm * vc),
           sd: Math.sqrt(vm), sdC: Math.sqrt(vc), neg: 100 * neg / n, negC: 100 * negC / n };
}

function toHourly(a) {
  const out = [];
  for (let i = 0; i < a.length; i += 12) {
    let s = 0, k = 0;
    for (let j = i; j < i + 12; j++) if (a[j] !== null) { s += a[j]; k++; }
    out.push(k ? s / k : null);
  }
  return out;
}

function yLayout(title) {
  return {
    title: { text: title, font: { size: 13, color: TH.ink } },
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'Segoe UI, system-ui, sans-serif', size: 12, color: TH.muted },
    margin: { l: 52, r: 14, t: 34, b: 38 },
    xaxis: { gridcolor: TH.axis, linecolor: TH.line, zeroline: false },
    yaxis: { gridcolor: TH.axis, linecolor: TH.line, zerolinecolor: TH.line },
    legend: { orientation: 'h', y: 1.16, x: 0 }, hovermode: 'x unified'
  };
}
const yCfg = { displayModeBar: false, responsive: true };

function yCards(da, rt) {
  const rows = [
    ['Day-ahead error', '$' + yFmt(da.mae), `R38 $${yFmt(REF_R38.da)}`],
    ['Real-time error', '$' + yFmt(rt.mae), `R38 $${yFmt(REF_R38.rt)}`],
    ['Day-ahead correlation', yFmt(da.corr), 'real time ' + yFmt(rt.corr)],
    ['Day-ahead level', '$' + yFmt(da.model, 1), 'CAISO $' + yFmt(da.caiso, 1)],
    ['Real-time level', '$' + yFmt(rt.model, 1), 'CAISO $' + yFmt(rt.caiso, 1)],
    ['5-minute volatility', yFmt(rt.sd, 1), 'CAISO ' + yFmt(rt.sdC, 1)],
    ['Intervals below $0', yFmt(rt.neg, 1) + ' %', 'CAISO ' + yFmt(rt.negC, 1) + ' %']
  ];
  document.getElementById('yearKpis').innerHTML = rows.map(([l, v, s]) =>
    `<div class="kpi"><div class="lbl">${l}</div><div class="val mono">${v}</div><div class="foot">${s}</div></div>`).join('');
}

function yWeekly() {
  const w = YEAR.weekly;
  document.getElementById('yearTbl').innerHTML =
    '<thead><tr><th class="l">Week</th><th>DA model</th><th>DA CAISO</th><th>DA MAE</th><th>DA corr</th>' +
    '<th>RT model</th><th>RT CAISO</th><th>RT MAE</th><th>RT corr</th><th>RT &lt; $0</th></tr></thead><tbody>' +
    w.map(r => `<tr><td class="l">${r.week}</td><td>${yFmt(r.DA_mean, 1)}</td><td>${yFmt(r.CAISO_DA_mean, 1)}</td>` +
      `<td>${yFmt(r.DA_MAE)}</td><td>${yFmt(r.DA_corr)}</td><td>${yFmt(r.RT_mean, 1)}</td>` +
      `<td>${yFmt(r.CAISO_RT_mean, 1)}</td><td>${yFmt(r.RT_MAE)}</td><td>${yFmt(r.RT_corr)}</td>` +
      `<td>${yFmt(r.RT_neg, 1)} %</td></tr>`).join('') + '</tbody>';
}

async function renderYear() {
  if (!YEAR) {
    try {
      YEAR = await window.loadJSON(YEAR_URL);
    } catch (e) {
      document.getElementById('yearKpis').innerHTML = `<div class="kpi">year data not available: ${e.message}</div>`;
      return;
    }
  }
  const da = yStats(YEAR.ca_da.model, YEAR.ca_da.caiso);
  const rt5 = yStats(YEAR.ca5.model, YEAR.ca5.caiso);
  const rth = yStats(toHourly(YEAR.ca5.model), toHourly(YEAR.ca5.caiso));
  rth.sd = rt5.sd; rth.sdC = rt5.sdC; rth.neg = rt5.neg; rth.negC = rt5.negC;
  yCards(da, rth);

  const m = YEAR.monthly, x = m.map(r => r.month.slice(5));
  Plotly.newPlot('yearErr', [
    { x, y: m.map(r => r.DA_MAE), name: 'day-ahead', type: 'bar', marker: { color: C_MODEL } },
    { x, y: m.map(r => r.RT_MAE), name: 'real time', type: 'bar', marker: { color: C_ACTUAL } }
  ], Object.assign(yLayout('Mean absolute error by month, $/MWh'), { barmode: 'group' }), yCfg);

  Plotly.newPlot('yearLvl', [
    { x, y: m.map(r => r.DA_mean), name: 'model DA', mode: 'lines+markers', line: { color: C_MODEL, width: 2 } },
    { x, y: m.map(r => r.CAISO_DA_mean), name: 'CAISO DA', mode: 'lines+markers', line: { color: C_ACTUAL, width: 2, dash: 'dot' } },
    { x, y: m.map(r => r.RT_mean), name: 'model RT', mode: 'lines', line: { color: C_MODEL, width: 1.3, dash: 'dash' } },
    { x, y: m.map(r => r.CAISO_RT_mean), name: 'CAISO RT', mode: 'lines', line: { color: C_ACTUAL, width: 1.3, dash: 'dashdot' } }
  ], yLayout('Monthly mean price, $/MWh'), yCfg);

  const hx = Array.from({ length: 24 }, (_, i) => i);
  const shape = (id, a, b, t) => Plotly.newPlot(id, [
    { x: hx, y: a, name: 'model', mode: 'lines', line: { color: C_MODEL, width: 2.4 } },
    { x: hx, y: b, name: 'CAISO', mode: 'lines', line: { color: C_ACTUAL, width: 2.4, dash: 'dot' } }
  ], Object.assign(yLayout(t), { xaxis: { title: 'hour (UTC−6)', dtick: 3, gridcolor: TH.axis, linecolor: TH.line } }), yCfg);
  shape('yearHodDA', YEAR.hourly.model_da, YEAR.hourly.caiso_da, 'Day-ahead: average day, $/MWh');
  shape('yearHodRT', YEAR.hourly.model_rt, YEAR.hourly.caiso_rt, 'Real time: average day, $/MWh');

  yWeekly();
}

window.renderYear = renderYear;
