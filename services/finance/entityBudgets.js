// ============================================================================
// Module Finance — phase 2, lot A : budgets d'ENTITÉ (Cluster, Xperio) et budgets DÉPARTEMENTAUX.
//
// Ce sont des écrans À PART du Budget maître (qui reste le chiffre officiel) : le budget
// « Sep 2026 → Dec 2027 » de la CFO, tel qu'elle l'a monté dans Cluster_Budget_Sep2026_Dec2027.xlsx,
// avec ses drivers GL modifiables. Les CALCULS se font dans le navigateur
// (frontend src/pages/Finance/EntityBudgets/entityModel.ts) ; le serveur garde :
//   - la RÉFÉRENCE de chaque budget, une ligne `finance_budgets` par entité :
//       entity = 'cluster' | 'xperio'  → lignes du P&L autonome + drivers GL (identifiant STABLE)
//       entity = 'departments'         → feuilles « Dept - … » + vue Département / Leader
//     Ligne séparée pour les départements (et non une clé dans la référence consolidée) : la
//     référence consolidée part chez TOUT détenteur de finance:view, les départements exigent
//     finance:dept_budgets.
//   - les AJUSTEMENTS de la CFO (pourcentages tapés dans les cellules jaunes), dans finance_state,
//     section 'drivers', données { ov: { <id du driver>: <pourcentage> } } ;
//   - le STATUT : approuver / déverrouiller passent par les routes de la phase 1
//     (POST /api/finance/budgets/:id/approve|unlock) — un budget approuvé est VERROUILLÉ.
//
// Identifiant stable d'un driver : 'd' + 12 premiers caractères hexadécimaux du SHA-1 de
//   « entité | section | catégorie | compte GL | compte parent | type de driver »
// (compte parent = le GL de paie auquel se rattache une ligne de charges sociales, '' sinon), avec
// « #2 », « #3 »… ajouté avant le hachage pour un doublon, dans l'ordre du fichier (aucun doublon
// dans le classeur actuel). Ni la « sous-catégorie » de budget_data.js (un numéro de ligne laissé
// par l'extraction : « 98 », « 125 »…) ni le département (vide dans budget_data.js, rempli dans le
// classeur) n'y entrent : le même driver a le même identifiant, qu'il vienne du paquet de
// passation ou d'un ré-import du classeur. Le type y entre exprès : un driver qui passe de
// « Run-rate » à « Monthly growth » ne garde pas un pourcentage qui voulait dire autre chose.
//
// Aucune donnée de la CFO ici : on lit ce qu'on nous donne (paquet de passation via handoff.js,
// classeur téléversé par la CFO).
// ============================================================================

const crypto = require('crypto');

const PERM_ENTITY = 'finance:entity_budgets';
const PERM_DEPT = 'finance:dept_budgets';
const FY = 2027;
const ENTITIES = { cluster: 'Cluster', xperio: 'Xperio' };
const DEPT_ROW = 'departments';
const SAVE_LOG_EVERY_MS = 15 * 60 * 1000;
const MAX_ABS = 1e10;
// Pourcentage saisi dans une cellule jaune : -100 % (tout retirer) à +500 %.
const OV_MIN = -100;
const OV_MAX = 500;
const TOL = 0.05; // tolérance des contrôles d'addition du classeur ($)

// Les 23 lignes du P&L autonome, dans l'ordre du classeur.
const PL_NAMES = [
  'Revenue', 'Recurring Revenue', 'Hardware Revenue', 'Service Revenue', 'Licence & Other Revenue', 'Total Revenue',
  'Cost of Goods Sold', 'Recurring COGS', 'Hardware COGS', 'Service COGS', 'Licence COGS', 'Total COGS',
  'GROSS PROFIT', 'Gross Margin',
  'Operating Expenses', 'Sales & Marketing', 'Research & Development', 'General & Administrative', 'Total OPEX',
  'EBITDA', 'Non-operating Income', 'Non-operating Expense', 'NET INCOME / (LOSS)',
];
const PL_HEADERS = new Set(['Revenue', 'Cost of Goods Sold', 'Operating Expenses']);
const REV = ['Recurring Revenue', 'Hardware Revenue', 'Service Revenue', 'Licence & Other Revenue'];
const COGS = ['Recurring COGS', 'Hardware COGS', 'Service COGS', 'Licence COGS'];
const OPX = ['Sales & Marketing', 'Research & Development', 'General & Administrative'];
const LINE_NAMES = [...REV, ...COGS, ...OPX, 'Non-operating Income', 'Non-operating Expense'];
// Catégories de drivers regroupées sous une ligne du P&L (même table que `catMap` du prototype).
const CAT_MAP = {
  'Licence & Other Revenue': ['Other Revenue', 'License Revenue', 'Licence & Other Revenue'],
  'Licence COGS': ['License COGS', 'Licence COGS'],
  'Service COGS': ['Service COGS', 'Service Auto', 'Service Travel'],
  'Recurring COGS': ['Recurring COGS', 'Support Software & Phone Costs'],
  'Non-operating Income': ['Non-Operating Income', 'Gain on Sale of Division'],
  'Non-operating Expense': ['Other Non-Operating Expenses', 'Non-Operating Professional Expenses', 'Exchange Gain or Loss', 'Amortization'],
};
const lineOfCat = (cat) => LINE_NAMES.find((l) => (CAT_MAP[l] || [l]).includes(cat)) || null;
const DRIVER_TYPES = ['Run-rate', 'Monthly growth', 'Payroll allocation', 'Contractor schedule', 'Revenue-linked', 'One-time / zero', 'Manual / event'];
const DRIVER_SECTIONS = ['Revenue', 'COGS', 'OPEX', 'Non-operating Income', 'Non-operating Expense'];
const recomputable = (d) => (d.type === 'Run-rate' || d.type === 'Monthly growth') && d.base != null && Number.isFinite(d.base);

// Feuilles des départements. `title` : le nom du budget de leader (vue Département / Leader du
// sommaire) ; `contribution` : le budget « Ventes » est une CONTRIBUTION (revenus − S&M), pas une
// dépense.
const DEPTS = [
  { key: 'sales', sheet: 'Dept - Sales', handoff: 'deptSales', title: 'Sales Department Budget', leader: /^sales/i, contribution: true },
  { key: 'rd', sheet: 'Dept - R&D', handoff: 'deptRD', title: 'R&D Department Budget', leader: /^r&d/i },
  { key: 'ops', sheet: 'Dept - Delivery Ops', handoff: 'deptOps', title: 'Delivery, Support, IT, Control Plus & Operations Budget', leader: /^delivery/i },
  { key: 'acct', sheet: 'Dept - Accounting', handoff: 'deptAcct', title: 'Accounting Department Budget', leader: /^accounting/i },
];
const LEADER_HEAD = 'Department / Leader View';

// ---------------------------------------------------------------------------- outils
const sum = (a, from = 0, to = a.length) => { let s = 0; for (let i = from; i < to; i++) s += a[i] || 0; return s; };
const round2 = (v) => Math.round(v * 100) / 100;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const text = (v) => (v == null ? '' : String(v).trim());
// Lettre de colonne Excel d'un indice 0 (0 → A).
const colLetter = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
// Cellule numérique : null si vide, NaN si illisible.
function cellNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (v instanceof Date) return NaN;
  const s = String(v).trim();
  if (s === '' || s === '-' || s === '–') return null;
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()$,\s ]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

// ---------------------------------------------------------------------------- identifiants
function idBase(d) { return [d.ent, d.sec, d.cat, d.gl, d.parent || '', d.type].join('|'); }
function assignIds(drivers) {
  const seen = new Map();
  for (const d of drivers) {
    const b = idBase(d);
    const k = (seen.get(b) || 0) + 1;
    seen.set(b, k);
    d.id = 'd' + crypto.createHash('sha1').update(k === 1 ? b : `${b}#${k}`).digest('hex').slice(0, 12);
  }
  return drivers;
}

// Champs comparés par l'aperçu d'un import. Le département n'en fait pas partie : il n'est ni affiché
// ni calculé, et budget_data.js le laisse vide là où le classeur le remplit.
const DRIVER_FIELDS = ['ent', 'sec', 'cat', 'parent', 'gl', 'type', 'basis', 'janAug', 'aug', 'base', 'input', 'esc', 'note', 'm'];
function normDriver(d) {
  return {
    ent: d.ent, sec: d.sec, cat: d.cat, parent: d.parent || '', dept: d.dept || '', gl: d.gl, type: d.type,
    basis: d.basis || '', janAug: d.janAug || 0, aug: d.aug || 0, base: d.base == null ? null : d.base,
    input: d.input || 0, esc: d.esc || 0, note: d.note || '', m: d.m.map((x) => x || 0),
  };
}

function buildEntityReference(entity, pl, drivers, source) {
  const ent = ENTITIES[entity];
  return {
    v: 1,
    kind: 'entity',
    entity: ent,
    fiscalYear: FY,
    source,
    pl: PL_NAMES.map((name) => {
      const r = pl.find((x) => x.name === name);
      return { name, v: r ? r.v.slice(0, 21).map((x) => (x == null ? null : x)) : Array(21).fill(null) };
    }),
    drivers: assignIds(drivers.filter((d) => d.ent === ent).map(normDriver)),
  };
}

// Paquet de passation (window.BUDGET de budget_data.js) → les trois références.
function fromHandoffBudget(B) {
  // Ligne de charges sociales : « sub » porte le GL de paie parent ; sinon c'est un numéro de ligne.
  const drivers = B.drivers.map((d) => ({ ...d, parent: d.dept && Number.isNaN(Number(d.sub)) ? String(d.sub) : '' }));
  const source = { kind: 'handoff', file: 'budget_data.js' };
  const metrics = [];
  const leaderRows = [];
  let inLeaders = false;
  for (const r of B.summary) {
    if (r.name === LEADER_HEAD) { inLeaders = true; continue; }
    (inLeaders ? leaderRows : metrics).push({ name: r.name, v: r.v.slice(0, 3).map((x) => (typeof x === 'number' ? x : null)) });
  }
  return {
    cluster: buildEntityReference('cluster', B.cluster, drivers, source),
    xperio: buildEntityReference('xperio', B.xperio, drivers, source),
    departments: {
      v: 1,
      kind: 'departments',
      fiscalYear: FY,
      source,
      summary: metrics,
      leaders: DEPTS.map((d) => {
        const r = leaderRows.find((x) => d.leader.test(x.name));
        return { key: d.key, name: r ? r.name : d.title, v: r ? r.v : [null, null, null] };
      }),
      depts: DEPTS.map((d) => ({
        key: d.key, title: d.title, contribution: !!d.contribution,
        rows: (B[d.handoff] || []).map((r) => ({ name: r.name, v: r.v.slice(0, 21).map((x) => (typeof x === 'number' ? x : null)), basis: null })),
      })),
    },
  };
}

// ---------------------------------------------------------------------------- lecture du classeur
const findSheet = (book, test) => book.sheetNames.find((n) => test(n.trim().toLowerCase()));
const MAX_MSG = 60;
function msgs() {
  const errors = [], warnings = [];
  return {
    errors, warnings,
    err: (code, p = {}) => { if (errors.length < MAX_MSG) errors.push({ code, ...p }); },
    warn: (code, p = {}) => { if (warnings.length < MAX_MSG) warnings.push({ code, ...p }); },
  };
}

// Contrôles d'addition d'un P&L autonome (avertissements : le moteur recalcule les totaux depuis
// les lignes, mais un classeur qui ne s'additionne pas mérite un coup d'œil).
function tieOutPl(pl, sheet, M) {
  const row = (n) => (pl.find((r) => r.name === n) || { v: [] }).v;
  const at = (n, c) => row(n)[c] || 0;
  for (let c = 0; c < 18; c++) {
    const tr = REV.reduce((a, n) => a + at(n, c), 0);
    const tc = COGS.reduce((a, n) => a + at(n, c), 0);
    const to = OPX.reduce((a, n) => a + at(n, c), 0);
    const exp = { 'Total Revenue': tr, 'Total COGS': tc, 'GROSS PROFIT': tr - tc, 'Total OPEX': to, EBITDA: tr - tc - to,
      'NET INCOME / (LOSS)': tr - tc - to + at('Non-operating Income', c) - at('Non-operating Expense', c) };
    for (const [n, e] of Object.entries(exp)) {
      if (Math.abs(at(n, c) - e) > TOL) M.warn('tie_out', { sheet, row: n, col: c, column: colLetter(c + 1), expected: round2(e), actual: round2(at(n, c)) });
    }
  }
  for (const r of pl) {
    if (PL_HEADERS.has(r.name) || r.name === 'Gross Margin') continue;
    const tots = [sum(r.v, 2, 6), sum(r.v, 6, 18), sum(r.v, 2, 18)];
    tots.forEach((e, i) => { if (r.v[18 + i] != null && Math.abs(r.v[18 + i] - e) > TOL) M.warn('total_col', { sheet, row: r.name, col: 18 + i, column: colLetter(19 + i), expected: round2(e), actual: round2(r.v[18 + i]) }); });
  }
}

function readChecks(book, M) {
  const sh = findSheet(book, (n) => n === 'checks');
  if (!sh) return null;
  const R = book.rows(sh);
  const h = R.findIndex((r) => r && text(r[0]) === 'Check');
  if (h < 0) return null;
  const out = [];
  for (const r of R.slice(h + 1)) {
    if (!r || !text(r[0])) continue;
    const status = text(r[5]);
    out.push({ check: text(r[0]), status });
    if (status && status.toUpperCase() !== 'PASS') M.warn('check_failed', { check: text(r[0]), status });
  }
  return out;
}

function parsePlSheet(book, sheet, M) {
  const R = book.rows(sheet);
  const h = R.findIndex((r) => r && text(r[0]) === 'CAD');
  if (h < 0) { M.err('missing_header', { sheet, expected: 'CAD' }); return null; }
  const pl = [];
  for (const name of PL_NAMES) {
    if (PL_HEADERS.has(name)) { pl.push({ name, v: Array(21).fill(null) }); continue; }
    const i = R.findIndex((r, k) => k > h && r && text(r[0]) === name);
    if (i < 0) { M.err('missing_row', { sheet, row: name }); continue; }
    const v = [];
    for (let c = 0; c < 21; c++) {
      const x = cellNum(R[i][c + 1]);
      if (Number.isNaN(x)) { M.err('bad_number', { sheet, row: name, line: i + 1, column: colLetter(c + 1) }); v.push(null); } else v.push(x);
    }
    pl.push({ name, v });
  }
  return pl;
}

// Feuille « Drivers → » : 33 colonnes, Entity | P&L Section | Category | Subcategory | Department |
// Exact GL Account | Driver Type | Driver Reference | Jan–Aug | Aug | Normalized Base | Driver Input |
// Jan-27 Escalation | Note | 16 mois | 3 totaux.
function parseDriverSheet(book, sheet, ent, M) {
  const R = book.rows(sheet);
  const h = R.findIndex((r) => r && text(r[0]) === 'Entity' && /gl/i.test(text(r[5])));
  if (h < 0) { M.err('missing_header', { sheet, expected: 'Entity' }); return []; }
  const out = [];
  for (let k = h + 1; k < R.length; k++) {
    const r = R[k];
    if (!r || text(r[0]) !== ent) continue;
    const line = k + 1;
    const d = {
      ent, sec: text(r[1]), cat: text(r[2]), parent: text(r[3]), dept: text(r[4]), gl: text(r[5]), type: text(r[6]),
      basis: text(r[7]), note: text(r[13]),
    };
    if (!d.gl) { M.err('driver_no_gl', { sheet, line }); continue; }
    if (!DRIVER_TYPES.includes(d.type)) M.err('bad_driver_type', { sheet, line, gl: d.gl, type: d.type });
    if (!DRIVER_SECTIONS.includes(d.sec)) M.err('bad_driver_section', { sheet, line, gl: d.gl, section: d.sec });
    if (!lineOfCat(d.cat)) M.err('unknown_category', { sheet, line, gl: d.gl, category: d.cat });
    const num = (c, field, dflt) => {
      const x = cellNum(r[c]);
      if (Number.isNaN(x) || (x != null && Math.abs(x) > MAX_ABS)) { M.err('bad_driver_number', { sheet, line, gl: d.gl, field }); return dflt; }
      return x == null ? dflt : x;
    };
    d.janAug = num(8, 'janAug', 0);
    d.aug = num(9, 'aug', 0);
    d.base = num(10, 'base', null);
    d.input = num(11, 'input', 0);
    d.esc = num(12, 'esc', 0);
    d.m = Array.from({ length: 16 }, (_, i) => num(14 + i, `m${i}`, 0));
    if (d.esc < 0 || d.esc > 1) M.err('bad_driver_number', { sheet, line, gl: d.gl, field: 'esc' });
    out.push(d);
  }
  if (!out.length) M.err('no_drivers', { sheet, entity: ent });
  return out;
}

// Écart connu entre une ligne du P&L et la somme de ses drivers (5 lignes de COGS dans le classeur
// actuel) : la ligne fait foi, l'écart est signalé dans l'aperçu.
function driverGaps(ref) {
  const out = [];
  for (const line of LINE_NAMES) {
    const row = ref.pl.find((r) => r.name === line);
    if (!row) continue;
    const ds = ref.drivers.filter((d) => (CAT_MAP[line] || [line]).includes(d.cat));
    const lineT = sum(row.v, 2, 18);
    const drvT = ds.reduce((a, d) => a + sum(d.m), 0);
    if (Math.abs(lineT - drvT) > 0.5) out.push({ line, lineTotal: round2(lineT), driversTotal: round2(drvT), gap: round2(lineT - drvT) });
  }
  return out;
}

function parseEntityWorkbook(book, entity) {
  const M = msgs();
  const ent = ENTITIES[entity];
  const plSheet = findSheet(book, (n) => n === `${ent.toLowerCase()} p&l`);
  const drvSheet = findSheet(book, (n) => n.startsWith('drivers'));
  if (!plSheet) M.err('missing_sheet', { sheet: `${ent} P&L` });
  if (!drvSheet) M.err('missing_sheet', { sheet: 'Drivers →' });
  if (!plSheet || !drvSheet) return { ...M, ref: null };
  const pl = parsePlSheet(book, plSheet, M);
  const drivers = parseDriverSheet(book, drvSheet, ent, M);
  if (M.errors.length) return { errors: M.errors, warnings: M.warnings, ref: null };
  tieOutPl(pl, plSheet, M);
  const checks = readChecks(book, M);
  const ref = buildEntityReference(entity, pl, drivers, { kind: 'xlsx', sheets: [plSheet, drvSheet] });
  return { errors: M.errors, warnings: M.warnings, checks, gaps: driverGaps(ref), ref };
}

function parseDeptWorkbook(book) {
  const M = msgs();
  const depts = [];
  for (const d of DEPTS) {
    const sheet = findSheet(book, (n) => n === d.sheet.toLowerCase());
    if (!sheet) { M.err('missing_sheet', { sheet: d.sheet }); continue; }
    const R = book.rows(sheet);
    const h = R.findIndex((r) => r && text(r[0]) === 'Expense Line');
    if (h < 0) { M.err('missing_header', { sheet, expected: 'Expense Line' }); continue; }
    const rows = [];
    for (let k = h + 1; k < R.length; k++) {
      const r = R[k];
      const name = r && typeof r[0] === 'string' ? r[0].trim() : '';
      if (!name) continue;
      const v = [];
      for (let c = 0; c < 21; c++) {
        const x = cellNum(r[c + 1]);
        if (Number.isNaN(x)) { M.err('bad_number', { sheet, row: name, line: k + 1, column: colLetter(c + 1) }); v.push(null); } else v.push(x);
      }
      rows.push({ name, v, basis: text(r[22]) || null });
    }
    if (!rows.length) M.err('no_rows', { sheet });
    // Total de chaque ligne à valeurs : colonnes de totaux = somme des mois.
    for (const r of rows) {
      if (!r.v.slice(0, 18).some((x) => x != null)) continue;
      [sum(r.v, 2, 6), sum(r.v, 6, 18), sum(r.v, 2, 18)].forEach((e, i) => {
        if (r.v[18 + i] != null && Math.abs(r.v[18 + i] - e) > TOL) M.warn('total_col', { sheet, row: r.name, col: 18 + i, column: colLetter(19 + i), expected: round2(e), actual: round2(r.v[18 + i]) });
      });
    }
    depts.push({ key: d.key, title: text((R[0] || [])[0]) || d.title, contribution: !!d.contribution, rows });
  }
  const sumSheet = findSheet(book, (n) => n.includes('summary'));
  const summary = [];
  const leaderRows = [];
  if (!sumSheet) M.err('missing_sheet', { sheet: 'FY2026 Summary' });
  else {
    const R = book.rows(sumSheet);
    const h = R.findIndex((r) => r && text(r[0]) === 'Metric');
    if (h < 0) M.err('missing_header', { sheet: sumSheet, expected: 'Metric' });
    else {
      let inLeaders = false;
      for (let k = h + 1; k < R.length; k++) {
        const r = R[k];
        const name = r && typeof r[0] === 'string' ? r[0].trim() : '';
        if (!name) continue;
        if (name === LEADER_HEAD) { inLeaders = true; continue; }
        const v = [1, 2, 3].map((c) => cellNum(r[c]));
        if (v.some((x) => Number.isNaN(x))) { M.err('bad_number', { sheet: sumSheet, row: name, line: k + 1, column: colLetter(v.findIndex((x) => Number.isNaN(x)) + 1) }); continue; }
        (inLeaders ? leaderRows : summary).push({ name, v });
      }
    }
  }
  const leaders = DEPTS.map((d) => {
    const r = leaderRows.find((x) => d.leader.test(x.name));
    if (!r && sumSheet) M.err('missing_row', { sheet: sumSheet, row: d.title });
    return { key: d.key, name: r ? r.name : d.title, v: r ? r.v : [null, null, null] };
  });
  if (M.errors.length) return { errors: M.errors, warnings: M.warnings, ref: null };
  // Le budget du leader = la dernière ligne TOTAL / NET de sa feuille.
  for (const L of leaders) {
    const dep = depts.find((x) => x.key === L.key);
    const last = [...dep.rows].reverse().find((r) => /^(TOTAL|NET)/.test(r.name));
    if (!last) continue;
    [0, 1, 2].forEach((i) => {
      if (L.v[i] != null && last.v[18 + i] != null && Math.abs(L.v[i] - last.v[18 + i]) > TOL) {
        M.warn('leader_tie_out', { leader: L.name, col: i, column: colLetter(i + 1), expected: round2(last.v[18 + i]), actual: round2(L.v[i]) });
      }
    });
  }
  const ref = { v: 1, kind: 'departments', fiscalYear: FY, source: { kind: 'xlsx' }, summary, leaders, depts };
  return { errors: M.errors, warnings: M.warnings, ref };
}

// ---------------------------------------------------------------------------- aperçu d'un import
// Totaux de la SOURCE (sans ajustements), exercice 2027 et 16 mois : ce que le classeur dit.
function plTotals(ref) {
  const out = {};
  for (const [k, from, to] of [['fy', 6, 18], ['t16', 2, 18]]) {
    const line = (n) => { const r = ref.pl.find((x) => x.name === n); return r ? sum(r.v, from, to) : 0; };
    const rev = REV.reduce((a, n) => a + line(n), 0);
    const cogs = COGS.reduce((a, n) => a + line(n), 0);
    const opex = OPX.reduce((a, n) => a + line(n), 0);
    const ebitda = rev - cogs - opex;
    out[k] = { revenue: round2(rev), cogs: round2(cogs), grossProfit: round2(rev - cogs), opex: round2(opex), ebitda: round2(ebitda),
      netIncome: round2(ebitda + line('Non-operating Income') - line('Non-operating Expense')) };
  }
  return out;
}

const sameVals = (a, b) => a.length === b.length && a.every((x, i) => (x == null && b[i] == null) || (x != null && b[i] != null && Math.abs(x - b[i]) < 0.005));

// Ajustements gardés (le driver existe toujours et reste modifiable) et abandonnés.
function splitOverrides(ov, ref) {
  const byId = new Map(ref.drivers.map((d) => [d.id, d]));
  const kept = {}, dropped = [];
  for (const [id, v] of Object.entries(ov || {})) {
    const d = byId.get(id);
    if (d && recomputable(d)) kept[id] = v; else dropped.push(id);
  }
  return { kept, dropped };
}

function diffEntity(oldRef, newRef, ov) {
  const lines = [];
  for (const r of newRef.pl) {
    if (PL_HEADERS.has(r.name)) continue;
    const o = oldRef ? oldRef.pl.find((x) => x.name === r.name) : null;
    if (o && sameVals(o.v.slice(0, 18), r.v.slice(0, 18))) continue;
    lines.push({ name: r.name, fyBefore: o ? round2(sum(o.v, 6, 18)) : null, fyAfter: round2(sum(r.v, 6, 18)) });
  }
  const oldBy = new Map((oldRef ? oldRef.drivers : []).map((d) => [d.id, d]));
  const newIds = new Set(newRef.drivers.map((d) => d.id));
  const added = newRef.drivers.filter((d) => !oldBy.has(d.id)).map((d) => ({ id: d.id, gl: d.gl, cat: d.cat, type: d.type }));
  const removed = oldRef ? oldRef.drivers.filter((d) => !newIds.has(d.id)).map((d) => ({ id: d.id, gl: d.gl, cat: d.cat, type: d.type })) : [];
  let changed = 0;
  for (const d of newRef.drivers) {
    const o = oldBy.get(d.id);
    if (o && DRIVER_FIELDS.some((f) => (f === 'm' ? !sameVals(o.m, d.m) : typeof d[f] === 'number' ? Math.abs((o[f] || 0) - d[f]) > 1e-9 : o[f] !== d[f]))) changed++;
  }
  const { kept, dropped } = splitOverrides(ov, newRef);
  const oldDrv = new Map((oldRef ? oldRef.drivers : []).map((d) => [d.id, d]));
  return {
    lines,
    drivers: { count: newRef.drivers.length, added, removed, changed },
    totals: { before: oldRef ? plTotals(oldRef) : null, after: plTotals(newRef) },
    overrides: { kept: Object.keys(kept).length, dropped: dropped.map((id) => ({ id, gl: (oldDrv.get(id) || {}).gl || id })) },
  };
}

// Une même ligne peut revenir deux fois dans une feuille (« Service Travel » : Cluster puis Xperio) :
// on apparie par nom ET rang d'apparition.
function keyedRows(rows) {
  const seen = new Map();
  return new Map(rows.map((r) => { const k = (seen.get(r.name) || 0) + 1; seen.set(r.name, k); return [`${r.name}#${k}`, r]; }));
}

function diffDept(oldRef, newRef) {
  const depts = newRef.depts.map((d) => {
    const o = oldRef ? oldRef.depts.find((x) => x.key === d.key) : null;
    const before = keyedRows(o ? o.rows : []);
    const after = keyedRows(d.rows);
    let changed = 0;
    for (const [k, r] of after) {
      const p = before.get(k);
      if (!p || !sameVals(p.v.slice(0, 18), r.v.slice(0, 18))) changed++;
    }
    const gone = [...before.keys()].filter((k) => !after.has(k)).length;
    return { key: d.key, rows: d.rows.length, changed, removed: gone };
  });
  const leaders = newRef.leaders.map((L) => {
    const o = oldRef ? oldRef.leaders.find((x) => x.key === L.key) : null;
    return { key: L.key, name: L.name, fyBefore: o ? o.v[1] : null, fyAfter: L.v[1], t16Before: o ? o.v[2] : null, t16After: L.v[2] };
  });
  return { depts, leaders };
}

// ---------------------------------------------------------------------------- écriture en base
async function loadOverrides(db, budgetId) {
  const r = await db.query("SELECT data, version FROM finance_state WHERE budget_id = $1 AND section = 'drivers'", [budgetId]);
  return r.rows[0] ? { ov: (r.rows[0].data && r.rows[0].data.ov) || {}, version: r.rows[0].version } : { ov: {}, version: 0 };
}

// Crée ou remplace la référence d'un budget d'entité / départemental (FY2027), DANS la transaction
// de l'appelant. Ajustements : gardés si le driver existe encore, les autres retirés (et listés).
// `keepExisting` : un budget déjà présent n'est pas touché (import initial du paquet).
async function upsertReference(db, rowEntity, ref, actor, { keepExisting = false } = {}) {
  const cur = await db.query('SELECT id FROM finance_budgets WHERE fiscal_year = $1 AND entity = $2', [FY, rowEntity]);
  const existing = cur.rows[0];
  if (existing && keepExisting) return { action: 'kept_existing', budgetId: existing.id, kept: null, dropped: [] };
  if (!existing) {
    const b = await db.query(
      'INSERT INTO finance_budgets (fiscal_year, entity, reference, imported_by) VALUES ($1, $2, $3::jsonb, $4) RETURNING id',
      [FY, rowEntity, JSON.stringify(ref), actor]);
    return { action: 'create', budgetId: b.rows[0].id, kept: 0, dropped: [] };
  }
  await db.query('UPDATE finance_budgets SET reference = $2::jsonb, imported_by = $3, imported_at = NOW(), updated_at = NOW() WHERE id = $1',
    [existing.id, JSON.stringify(ref), actor]);
  let kept = 0, dropped = [];
  if (ref.kind === 'entity') {
    const st = await loadOverrides(db, existing.id);
    const s = splitOverrides(st.ov, ref);
    kept = Object.keys(s.kept).length;
    dropped = s.dropped;
    if (dropped.length) {
      await db.query(
        "UPDATE finance_state SET data = $2::jsonb, version = version + 1, updated_by = $3, updated_at = NOW() WHERE budget_id = $1 AND section = 'drivers'",
        [existing.id, JSON.stringify({ ov: s.kept }), actor]);
    }
  }
  return { action: 'replace', budgetId: existing.id, kept, dropped };
}

async function withTx(pool, fn) {
  const client = pool.connect ? await pool.connect() : null;
  const db = client || pool;
  try {
    await db.query('BEGIN');
    try {
      const out = await fn(db);
      await db.query('COMMIT');
      return out;
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  } finally {
    if (client) client.release();
  }
}

// ---------------------------------------------------------------------------- modèles Excel
// Même disposition que le classeur de la CFO (le lecteur ci-dessus relit ce qu'on écrit ici) ;
// rempli avec le budget courant quand il existe, pour qu'elle parte de ses propres chiffres.
const MONTHS = ['Sep-26', 'Oct-26', 'Nov-26', 'Dec-26', 'Jan-27', 'Feb-27', 'Mar-27', 'Apr-27', 'May-27', 'Jun-27', 'Jul-27', 'Aug-27', 'Sep-27', 'Oct-27', 'Nov-27', 'Dec-27'];
const COL_HEAD = ['Jan–Aug 2026 Actual', 'Aug 2026 Actual', ...MONTHS, 'Sep–Dec 2026', 'FY2027', '16-Month Budget'];
const DRV_HEAD = ['Entity', 'P&L Section', 'Category', 'Subcategory', 'Department', 'Exact GL Account', 'Driver Type', 'Driver Reference',
  'Jan–Aug 2026 Actual', 'Aug-26 Actual', 'Normalized Base', 'Driver Input', 'Jan-27 Escalation', 'Source / Planning Note', ...MONTHS, 'Sep–Dec 2026', 'FY2027', '16-Month Budget'];

function entityTemplate(xlsx, entity, ref) {
  const ent = ENTITIES[entity];
  const wb = xlsx.utils.book_new();
  const pl = [[`${ent} | Standalone Budget P&L`], ['CAD · Jan–Aug 2026 actuals for reference · budget Sep 2026 → Dec 2027'], [], ['CAD', ...COL_HEAD], []];
  for (const name of PL_NAMES) {
    const r = ref ? ref.pl.find((x) => x.name === name) : null;
    pl.push(PL_HEADERS.has(name) ? [name] : [name, ...(r ? r.v.map((x) => (x == null ? null : x)) : Array(21).fill(null))]);
  }
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(pl), `${ent} P&L`);
  const dr = [['GL-Level Budget Drivers'], ['Driver Input and Jan-27 Escalation are fractions (0.015 = 1.5 %)'], [], [], DRV_HEAD];
  for (const d of ref ? ref.drivers : []) {
    dr.push([d.ent, d.sec, d.cat, d.parent || null, d.dept || null, d.gl, d.type, d.basis, d.janAug, d.aug, d.base, d.input, d.esc, d.note,
      ...d.m, sum(d.m, 0, 4), sum(d.m, 4, 16), sum(d.m)]);
  }
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(dr), 'Drivers →');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function deptTemplate(xlsx, ref) {
  const wb = xlsx.utils.book_new();
  const sm = [['September 2026 – December 2027 Budget Summary'], [], [], ['Metric', 'Sep–Dec 2026', 'FY2027', '16-Month Budget']];
  for (const r of ref ? ref.summary : []) sm.push([r.name, ...r.v]);
  sm.push([], [], [LEADER_HEAD, 'Sep–Dec 2026', 'FY2027', '16-Month Budget']);
  for (const d of DEPTS) {
    const L = ref ? ref.leaders.find((x) => x.key === d.key) : null;
    sm.push([L ? L.name : d.title, ...(L ? L.v : [null, null, null])]);
  }
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(sm), 'FY2026 Summary');
  for (const d of DEPTS) {
    const dep = ref ? ref.depts.find((x) => x.key === d.key) : null;
    const rows = [[dep ? dep.title : d.title], ['Leader-ready expense layout'], [], [], ['Expense Line', ...COL_HEAD, 'Driver / Basis', 'Leader Comments'], []];
    for (const r of dep ? dep.rows : []) {
      rows.push(r.v.slice(0, 18).some((x) => x != null) ? [r.name, ...r.v, r.basis] : [r.name]);
    }
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), d.sheet);
  }
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---------------------------------------------------------------------------- validation des ajustements
function validateOverrides(data, ref) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'bad_data';
  const ov = data.ov || {};
  if (typeof ov !== 'object' || Array.isArray(ov)) return 'bad_ov';
  const ok = new Set(ref.drivers.filter(recomputable).map((d) => d.id));
  for (const [k, v] of Object.entries(ov)) {
    if (!ok.has(k)) return `unknown_driver:${k}`;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < OV_MIN || v > OV_MAX) return `bad_driver:${k}`;
  }
  return { ov };
}

// ---------------------------------------------------------------------------- routes
function register(app, kit) {
  const { pool, authenticateToken, logActivity, PERMS } = kit;
  const { PERM_VIEW, PERM_EDIT, PERM_APPROVE } = PERMS;
  let xlsx = null;
  try { xlsx = require('xlsx'); } catch { /* bancs d'essai sans xlsx */ }
  const lastSaveLog = new Map();

  const budgetOut = (b) => ({
    id: b.id, fiscalYear: b.fiscal_year, entity: b.entity, status: b.status,
    approvedBy: b.approved_by, approvedAt: b.approved_at, importedAt: b.imported_at, importedBy: b.imported_by, updatedAt: b.updated_at,
  });
  const loadRow = async (rowEntity) => (await pool.query('SELECT * FROM finance_budgets WHERE fiscal_year = $1 AND entity = $2', [FY, rowEntity])).rows[0] || null;
  const entParam = (req, res) => {
    const k = String(req.params.entity || '').toLowerCase();
    if (!ENTITIES[k]) { res.status(404).json({ error: 'unknown_entity' }); return null; }
    return k;
  };
  const entityCaps = async (req) => {
    const edit = (await kit.can(req, PERM_EDIT)) && (await kit.can(req, PERM_ENTITY));
    return { canEdit: edit, canImport: edit, canApprove: await kit.can(req, PERM_APPROVE) };
  };
  const deptCaps = async (req) => ({ canImport: (await kit.can(req, PERM_EDIT)) && (await kit.can(req, PERM_DEPT)) });
  const uploadMw = (req, res, next) => {
    if (!kit.upload) return res.status(501).json({ error: 'upload_unavailable' });
    kit.upload(req, res, (e) => (e ? res.status(400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'bad_upload' }) : next()));
  };
  const sendXlsx = (res, name, buf) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buf);
  };
  const stateOut = (s) => (s ? { data: s.data, version: s.version, updatedBy: s.updated_by, updatedAt: s.updated_at } : null);

  async function entityPayload(req, k, row) {
    const caps = await entityCaps(req);
    if (!row) return { empty: true, entity: k, fiscalYear: FY, caps };
    const st = await pool.query("SELECT data, version, updated_by, updated_at FROM finance_state WHERE budget_id = $1 AND section = 'drivers'", [row.id]);
    return { budget: budgetOut(row), reference: row.reference, state: { drivers: stateOut(st.rows[0]) }, caps };
  }

  // ------------------------------------------------------------------------ budgets d'entité
  app.get('/api/finance/entity/:entity', authenticateToken, async (req, res) => {
    try {
      if (!(await kit.guardAll(req, res, [PERM_VIEW, PERM_ENTITY]))) return;
      const k = entParam(req, res);
      if (!k) return;
      res.json(await entityPayload(req, k, await loadRow(k)));
    } catch (e) {
      console.error('finance entity load:', e.message);
      res.status(500).json({ error: 'load_failed' });
    }
  });

  app.get('/api/finance/entity/:entity/template', authenticateToken, async (req, res) => {
    try {
      if (!(await kit.guardAll(req, res, [PERM_VIEW, PERM_ENTITY]))) return;
      const k = entParam(req, res);
      if (!k) return;
      if (!xlsx) return res.status(501).json({ error: 'xlsx_unavailable' });
      const row = await loadRow(k);
      sendXlsx(res, `${ENTITIES[k]}_Budget_Sep2026_Dec2027.xlsx`, entityTemplate(xlsx, k, row && row.reference));
    } catch (e) {
      console.error('finance entity template:', e.message);
      res.status(500).json({ error: 'template_failed' });
    }
  });

  // Ajustements des drivers : même concurrence optimiste et même verrou que la phase 1.
  app.put('/api/finance/entity/budgets/:id/drivers', authenticateToken, async (req, res) => {
    try {
      const b = await kit.writable(req, res, PERM_ENTITY);
      if (!b) return;
      if (!ENTITIES[b.entity]) return res.status(404).json({ error: 'not_entity_budget' });
      const v = validateOverrides(req.body && req.body.data, b.reference);
      if (typeof v === 'string') return res.status(400).json({ error: v });
      const version = Number(req.body.version) || 0;
      const email = req.user.email;
      let out;
      if (version === 0) {
        out = await pool.query(
          `INSERT INTO finance_state (budget_id, section, data, version, updated_by) VALUES ($1, 'drivers', $2::jsonb, 1, $3)
           ON CONFLICT (budget_id, section) DO NOTHING RETURNING version`,
          [b.id, JSON.stringify(v), email]);
      } else {
        out = await pool.query(
          `UPDATE finance_state SET data = $2::jsonb, version = version + 1, updated_by = $3, updated_at = NOW()
           WHERE budget_id = $1 AND section = 'drivers' AND version = $4 RETURNING version`,
          [b.id, JSON.stringify(v), email, version]);
      }
      if (!out.rows[0]) {
        const cur = await pool.query("SELECT data, version, updated_by, updated_at FROM finance_state WHERE budget_id = $1 AND section = 'drivers'", [b.id]);
        return res.status(409).json({ error: 'conflict', current: stateOut(cur.rows[0]) });
      }
      await kit.touch(b.id);
      const ent = ENTITIES[b.entity];
      const key = `${b.id}|${email}`;
      const now = Date.now();
      if (!Object.keys(v.ov).length) {
        await logActivity('finance_entity_budgets', String(b.id), 'reset', `Budget ${ent} ${b.fiscal_year} : drivers réinitialisés`, email, { metadata: { entity: b.entity } });
        lastSaveLog.delete(key);
      } else if (!lastSaveLog.has(key) || now - lastSaveLog.get(key) > SAVE_LOG_EVERY_MS) {
        lastSaveLog.set(key, now);
        await logActivity('finance_entity_budgets', String(b.id), 'edited', `Budget ${ent} ${b.fiscal_year} : drivers modifiés (${Object.keys(v.ov).length})`, email, { metadata: { entity: b.entity, count: Object.keys(v.ov).length } });
      }
      res.json({ version: out.rows[0].version });
    } catch (e) {
      console.error('finance entity drivers:', e.message);
      res.status(500).json({ error: 'save_failed' });
    }
  });

  // Import du classeur : 1er envoi = APERÇU (rien n'est écrit) ; 2e envoi du même fichier avec
  // `confirm` = jeton de l'aperçu (SHA-256 du fichier) et `base` = date d'import lue → enregistré.
  // Crée le budget s'il n'existe pas encore (base vide : la CFO peut partir de son classeur).
  app.post('/api/finance/entity/:entity/import', authenticateToken, uploadMw, async (req, res) => {
    try {
      if (!(await kit.guardAll(req, res, [PERM_EDIT, PERM_ENTITY]))) return;
      const k = entParam(req, res);
      if (!k) return;
      if (!req.file) return res.status(400).json({ error: 'no_file' });
      const book = kit.readWorkbook(req.file.buffer);
      if (!book) return res.status(400).json({ error: 'unreadable' });
      const parsed = parseEntityWorkbook(book, k);
      if (parsed.errors.length) return res.status(400).json({ error: 'invalid_workbook', errors: parsed.errors, warnings: parsed.warnings });
      const token = sha256(req.file.buffer);
      const row = await loadRow(k);
      if (row && row.status === 'approved') return res.status(409).json({ error: 'locked', approvedBy: row.approved_by, approvedAt: row.approved_at });
      const ov = row ? (await loadOverrides(pool, row.id)).ov : {};
      const base = row ? new Date(row.imported_at).toISOString() : null;
      const preview = {
        token, base, entity: k, exists: !!row, file: req.file.originalname || null,
        ...diffEntity(row && row.reference, parsed.ref, ov),
        warnings: parsed.warnings, checks: parsed.checks, gaps: parsed.gaps,
      };
      const confirm = req.body && req.body.confirm;
      if (!confirm) return res.json({ preview });
      if (confirm !== token) return res.status(409).json({ error: 'token_mismatch' });
      if ((req.body.base || null) !== base) return res.status(409).json({ error: 'conflict' });
      const ref = { ...parsed.ref, source: { ...parsed.ref.source, file: req.file.originalname || null, sha256: token } };
      const email = req.user.email;
      const r = await withTx(pool, (db) => upsertReference(db, k, ref, email));
      await logActivity('finance_entity_budgets', String(r.budgetId), 'imported',
        `Budget ${ENTITIES[k]} ${FY} : classeur importé (${ref.drivers.length} drivers${r.dropped.length ? `, ${r.dropped.length} ajustement(s) retiré(s)` : ''})`,
        email, { metadata: { entity: k, file: req.file.originalname || null, sha256: token, dropped: r.dropped } });
      const payload = await entityPayload(req, k, await loadRow(k));
      res.json({ ...payload, applied: { action: r.action, kept: r.kept, dropped: preview.overrides.dropped } });
    } catch (e) {
      console.error('finance entity import:', e.message);
      res.status(500).json({ error: 'import_failed' });
    }
  });

  // ------------------------------------------------------------------------ budgets départementaux
  app.get('/api/finance/dept', authenticateToken, async (req, res) => {
    try {
      if (!(await kit.guardAll(req, res, [PERM_VIEW, PERM_DEPT]))) return;
      const caps = await deptCaps(req);
      const row = await loadRow(DEPT_ROW);
      if (!row) return res.json({ empty: true, fiscalYear: FY, caps });
      res.json({ budget: budgetOut(row), reference: row.reference, caps });
    } catch (e) {
      console.error('finance dept load:', e.message);
      res.status(500).json({ error: 'load_failed' });
    }
  });

  app.get('/api/finance/dept/template', authenticateToken, async (req, res) => {
    try {
      if (!(await kit.guardAll(req, res, [PERM_VIEW, PERM_DEPT]))) return;
      if (!xlsx) return res.status(501).json({ error: 'xlsx_unavailable' });
      const row = await loadRow(DEPT_ROW);
      sendXlsx(res, 'Department_Budgets_Sep2026_Dec2027.xlsx', deptTemplate(xlsx, row && row.reference));
    } catch (e) {
      console.error('finance dept template:', e.message);
      res.status(500).json({ error: 'template_failed' });
    }
  });

  app.post('/api/finance/dept/import', authenticateToken, uploadMw, async (req, res) => {
    try {
      if (!(await kit.guardAll(req, res, [PERM_EDIT, PERM_DEPT]))) return;
      if (!req.file) return res.status(400).json({ error: 'no_file' });
      const book = kit.readWorkbook(req.file.buffer);
      if (!book) return res.status(400).json({ error: 'unreadable' });
      const parsed = parseDeptWorkbook(book);
      if (parsed.errors.length) return res.status(400).json({ error: 'invalid_workbook', errors: parsed.errors, warnings: parsed.warnings });
      const token = sha256(req.file.buffer);
      const row = await loadRow(DEPT_ROW);
      if (row && row.status === 'approved') return res.status(409).json({ error: 'locked', approvedBy: row.approved_by, approvedAt: row.approved_at });
      const base = row ? new Date(row.imported_at).toISOString() : null;
      const preview = { token, base, exists: !!row, file: req.file.originalname || null, ...diffDept(row && row.reference, parsed.ref), warnings: parsed.warnings };
      const confirm = req.body && req.body.confirm;
      if (!confirm) return res.json({ preview });
      if (confirm !== token) return res.status(409).json({ error: 'token_mismatch' });
      if ((req.body.base || null) !== base) return res.status(409).json({ error: 'conflict' });
      const ref = { ...parsed.ref, source: { kind: 'xlsx', file: req.file.originalname || null, sha256: token } };
      const r = await withTx(pool, (db) => upsertReference(db, DEPT_ROW, ref, req.user.email));
      await logActivity('finance_dept_budgets', String(r.budgetId), 'imported', `Budgets départementaux ${FY} : classeur importé`, req.user.email,
        { metadata: { file: req.file.originalname || null, sha256: token } });
      const fresh = await loadRow(DEPT_ROW);
      res.json({ budget: budgetOut(fresh), reference: fresh.reference, caps: await deptCaps(req), applied: { action: r.action } });
    } catch (e) {
      console.error('finance dept import:', e.message);
      res.status(500).json({ error: 'import_failed' });
    }
  });
}

module.exports = {
  register,
  // Utilisés par import.js, handoff.js et les bancs d'essai.
  fromHandoffBudget, buildEntityReference, parseEntityWorkbook, parseDeptWorkbook, upsertReference, withTx,
  splitOverrides, diffEntity, diffDept, plTotals, validateOverrides, entityTemplate, deptTemplate, driverGaps,
  assignIds, idBase, recomputable, lineOfCat,
  ENTITIES, DEPT_ROW, FY, PERM_ENTITY, PERM_DEPT, PL_NAMES, LINE_NAMES, CAT_MAP, DEPTS,
};
