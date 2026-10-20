// ============================================================================
// Module Finance — Prévisions (lot C) : import Excel (lecture + validation → aperçu) et modèles
// téléchargeables (.xlsx générés ici, avec les bonnes colonnes).
//
// Règle commune : une cellule VIDE ne change rien ; une cellule remplie remplace la valeur
// courante. Rien n'est écrit avant que la CFO confirme l'aperçu (forecasts.js).
// ============================================================================

const { isYm, ym, yearMonths, cellYm, num, text, parseInvestmentWorkbook, ymAdd } = require('./forecastsCompute');

const MAX_ABS = 1e10;
const okNum = (v) => v != null && Number.isFinite(v) && Math.abs(v) < MAX_ABS;

// ---------------------------------------------------------------------------- catégories
const SALES_SERIES = ['budget', 'forecast', 'actual'];
const SALES_FIELDS = ['mrr', 'merchants', 'installs'];
const SERIES_ALIASES = { budget: 'budget', forecast: 'forecast', 'prévision': 'forecast', prevision: 'forecast', actual: 'actual', 'réel': 'actual', reel: 'actual' };

const PAY_ASSUMPTIONS = ['inst', 'conv', 'churn', 'arpuG', 'margin'];
const PAY_FIELDS = ['active', 'installs', 'conv', 'churned', 'grossFees', 'residual'];

const CASH_IN = ['saas', 'residual', 'hardware', 'otherIn'];
const CASH_OUT = ['payroll', 'vendors', 'debt', 'taxes', 'otherOut'];
const CASH_CATS = [...CASH_IN, ...CASH_OUT, 'interco'];
const WEEKS = 13;
const CASH_LABELS = {
  saas: 'SaaS collections', residual: 'Processor residuals', hardware: 'Hardware & services', otherIn: 'Other receipts',
  payroll: 'Payroll', vendors: 'Vendors (AP)', debt: 'Debt service', taxes: 'Taxes & remittances', otherOut: 'Other disbursements',
  interco: 'Inter-company (+ in / − out)',
};

// ---------------------------------------------------------------------------- xlsx
let xlsx = null;
try { xlsx = require('xlsx'); } catch { /* banc d'essai sans xlsx */ }

function bookBuffer(sheets) {
  if (!xlsx) return null;
  const wb = xlsx.utils.book_new();
  for (const [name, aoa, widths] of sheets) {
    const ws = xlsx.utils.aoa_to_sheet(aoa);
    if (widths) ws['!cols'] = widths.map((w) => ({ wch: w }));
    xlsx.utils.book_append_sheet(wb, ws, name);
  }
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const findHeader = (rows, test) => rows.findIndex((r) => r && test(text(r[0]).toLowerCase(), r));

// ---------------------------------------------------------------------------- ventes
function salesTemplate(year, doc) {
  const cells = (doc && doc.cells) || {};
  const aoa = [
    [`Sales Forecast · BvA — ${year}`],
    ['Series = budget | forecast | actual. An empty cell leaves the current value unchanged. Amounts in CAD; MRR added = net new monthly recurring revenue.'],
    [],
    ['Month (YYYY-MM)', 'Series', 'MRR added', 'New merchants', 'Installs'],
  ];
  for (const s of SALES_SERIES) {
    for (const k of yearMonths(year)) {
      const c = (cells[s] && cells[s][k]) || {};
      aoa.push([k, s, c.mrr ?? null, c.merchants ?? null, c.installs ?? null]);
    }
  }
  return bookBuffer([['Sales', aoa, [16, 12, 14, 14, 12]]]);
}

function parseSales(wb) {
  const name = wb.sheetNames.includes('Sales') ? 'Sales' : wb.sheetNames[0];
  const rows = wb.rows(name);
  const hi = findHeader(rows, (c0) => c0.startsWith('month') || c0.startsWith('mois'));
  if (hi < 0) return { error: 'header_not_found' };
  const cells = [];
  const errors = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (r.every((v) => v == null || text(v) === '')) continue;
    const k = cellYm(r[0]);
    const s = SERIES_ALIASES[text(r[1]).toLowerCase()];
    if (!k) { errors.push({ row: i + 1, code: 'bad_month' }); continue; }
    if (!s) { errors.push({ row: i + 1, code: 'bad_series' }); continue; }
    SALES_FIELDS.forEach((f, j) => {
      const raw = r[2 + j];
      if (raw == null || text(raw) === '') return;
      const v = num(raw);
      if (!okNum(v)) { errors.push({ row: i + 1, code: 'bad_number', field: f }); return; }
      cells.push({ ym: k, series: s, field: f, value: v });
    });
  }
  if (!cells.length && !errors.length) return { error: 'no_rows' };
  return { cells, errors };
}

// ---------------------------------------------------------------------------- paiements
function paymentsTemplate(doc, fromYm, toYm) {
  const a = (doc && doc.assumptions) || {};
  const ov = (doc && doc.overrides) || {};
  const desc = {
    inst: 'Installs per month (merchants boarded outside the conversion team)',
    conv: 'Conversion-team adds per month',
    churn: 'Monthly churn, % of active merchants',
    arpuG: 'Monthly growth of gross fees per merchant, %',
    margin: 'Processor margin, % of gross fees kept by Cluster',
  };
  const assumptions = [['Key', 'Value', 'Description'], ...PAY_ASSUMPTIONS.map((k) => [k, a[k] ?? null, desc[k]])];
  const actuals = [
    ['Overrides of the actuals read from Zentact. An empty cell keeps the Zentact value. Amounts in CAD (dollars, not cents).'],
    ['Month (YYYY-MM)', 'Active merchants', 'Installs', 'Conversion adds', 'Churned', 'Gross fees', 'Residual'],
  ];
  for (let k = fromYm; k <= toYm; k = ymAdd(k, 1)) {
    const o = ov[k] || {};
    actuals.push([k, ...PAY_FIELDS.map((f) => o[f] ?? null)]);
  }
  return bookBuffer([['Assumptions', assumptions, [10, 10, 70]], ['Actuals', actuals, [16, 16, 10, 16, 10, 14, 14]]]);
}

function parsePayments(wb) {
  const out = { assumptions: {}, overrides: {}, errors: [] };
  let found = false;
  if (wb.sheetNames.includes('Assumptions')) {
    found = true;
    const rows = wb.rows('Assumptions');
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const k = text(r[0]);
      if (!k) continue;
      if (!PAY_ASSUMPTIONS.includes(k)) { out.errors.push({ row: i + 1, code: 'unknown_key', key: k.slice(0, 40) }); continue; }
      if (r[1] == null || text(r[1]) === '') continue;
      const v = num(r[1]);
      if (!okNum(v)) { out.errors.push({ row: i + 1, code: 'bad_number', key: k }); continue; }
      out.assumptions[k] = v;
    }
  }
  if (wb.sheetNames.includes('Actuals')) {
    found = true;
    const rows = wb.rows('Actuals');
    const hi = findHeader(rows, (c0) => c0.startsWith('month') || c0.startsWith('mois'));
    if (hi < 0) out.errors.push({ code: 'header_not_found', sheet: 'Actuals' });
    else {
      for (let i = hi + 1; i < rows.length; i++) {
        const r = rows[i] || [];
        if (r.every((v) => v == null || text(v) === '')) continue;
        const k = cellYm(r[0]);
        if (!k) { out.errors.push({ row: i + 1, code: 'bad_month' }); continue; }
        PAY_FIELDS.forEach((f, j) => {
          const raw = r[1 + j];
          if (raw == null || text(raw) === '') return;
          const v = num(raw);
          if (!okNum(v) || v < 0) { out.errors.push({ row: i + 1, code: 'bad_number', field: f }); return; }
          (out.overrides[k] = out.overrides[k] || {})[f] = v;
        });
      }
    }
  }
  if (!found) return { error: 'sheets_not_found' };
  return out;
}

// ---------------------------------------------------------------------------- trésorerie
function cashTemplate(doc) {
  const d = doc || {};
  const lines = d.lines || {};
  const start = d.startDate || null;
  const weekHead = Array.from({ length: WEEKS }, (_, i) => {
    if (!start) return `W${i + 1}`;
    const t = new Date(`${start}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 7 * i);
    return `W${i + 1} ${t.toISOString().slice(0, 10)}`;
  });
  const aoa = [
    ['Holdco Cash Forecast — 13 weeks, direct method. Amounts in CAD. Receipts and disbursements are POSITIVE; inter-company is signed (+ in / − out). An empty cell leaves the current value unchanged.'],
    ['Start date (Monday, YYYY-MM-DD)', start],
    ['Opening balance', d.opening && d.opening.mode === 'manual' ? d.opening.amount ?? null : null],
    ['Reserve', d.reserve ?? null],
    [],
    ['Category', 'Label', ...weekHead],
    ...CASH_CATS.map((c) => [c, CASH_LABELS[c], ...Array.from({ length: WEEKS }, (_, i) => (lines[c] && lines[c][i] != null ? lines[c][i] : null))]),
  ];
  return bookBuffer([['Cash', aoa, [32, 28, ...Array(WEEKS).fill(14)]]]);
}

function parseCash(wb) {
  const name = wb.sheetNames.includes('Cash') ? 'Cash' : wb.sheetNames[0];
  const rows = wb.rows(name);
  const out = { lines: {}, errors: [] };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const c0 = text(r[0]).toLowerCase();
    if (c0.startsWith('start date')) {
      let v = r[1];
      if (v instanceof Date) { const d = new Date(v.getTime() + 12 * 3600 * 1000); v = d.toISOString().slice(0, 10); }
      v = text(v);
      if (v) {
        const d = new Date(`${v}T12:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime())) out.errors.push({ row: i + 1, code: 'bad_date' });
        else if (d.getUTCDay() !== 1) out.errors.push({ row: i + 1, code: 'not_monday' });
        else out.startDate = v;
      }
    } else if (c0.startsWith('opening balance') || c0.startsWith('reserve')) {
      if (r[1] == null || text(r[1]) === '') continue;
      const v = num(r[1]);
      if (!okNum(v)) { out.errors.push({ row: i + 1, code: 'bad_number' }); continue; }
      if (c0.startsWith('reserve')) { if (v < 0) out.errors.push({ row: i + 1, code: 'bad_number' }); else out.reserve = v; } else out.opening = v;
    }
  }
  const hi = findHeader(rows, (c0) => c0 === 'category' || c0 === 'catégorie');
  if (hi < 0) out.errors.push({ code: 'header_not_found' });
  else {
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const k = text(r[0]);
      if (!k) continue;
      if (!CASH_CATS.includes(k)) { out.errors.push({ row: i + 1, code: 'unknown_category', key: k.slice(0, 40) }); continue; }
      const vals = Array(WEEKS).fill(null);
      let any = false;
      for (let w = 0; w < WEEKS; w++) {
        const raw = r[2 + w];
        if (raw == null || text(raw) === '') continue;
        const v = num(raw);
        if (!okNum(v) || (k !== 'interco' && v < 0)) { out.errors.push({ row: i + 1, code: k !== 'interco' && v != null && v < 0 ? 'negative' : 'bad_number', week: w + 1 }); continue; }
        vals[w] = v; any = true;
      }
      if (any) out.lines[k] = vals;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- investissement
function investmentTemplate(months) {
  const head = ['Type', 'Name', 'P&L Mapping', 'Base Annual / Monthly', ...months.map((k) => k)];
  const note = ['Type = Employee | Contractor. Monthly amounts = cost allocated to the initiative. Optional row « Revenue » = return of the initiative (CAD).'];
  const sheet = (title) => [[title], note, [], head, ['Employee', '', 'R&D', null, ...months.map(() => null)], ['TOTAL', 'TOTAL INITIATIVE INVESTMENT', null, null, ...months.map(() => null)], [], ['Revenue', 'Initiative revenue', 'Recurring Revenue', null, ...months.map(() => null)]];
  return bookBuffer([['V2', sheet('V2 | Expense Budget'), [12, 30, 16, 18]], ['Payments Conversion', sheet('Payments Conversion | P&L & Expense Budget'), [12, 30, 16, 18]]]);
}

const parseInvestment = (wb) => {
  const p = parseInvestmentWorkbook(wb);
  if (!Object.keys(p).length) return { error: 'sheets_not_found' };
  return { programs: p };
};

module.exports = {
  SALES_SERIES, SALES_FIELDS, PAY_ASSUMPTIONS, PAY_FIELDS, CASH_IN, CASH_OUT, CASH_CATS, WEEKS,
  salesTemplate, parseSales, paymentsTemplate, parsePayments, cashTemplate, parseCash, investmentTemplate, parseInvestment,
  isYm, ym,
};
