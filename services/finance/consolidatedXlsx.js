// ============================================================================
// Module Finance — import Excel du budget CONSOLIDÉ (Salaires & contractuels, OPEX) : lecture,
// validation, comparaison et modèles. Fichier PUR : aucun accès base, aucun appel réseau.
//
// Deux classeurs de la CFO :
//   - « salary & contractors.xlsx » : feuille Payroll (détail des employés) et feuille
//     Contractors (détail des contractuels) ;
//   - « Book4.xlsx » : feuille OPEX (libellés en colonne A, 36 mois Jan-26 … Dec-28).
// Les en-têtes sont CHERCHÉS (pas de numéros de ligne en dur) : la CFO peut ajouter des lignes de
// titre au-dessus. Les formules sont lues en valeur CALCULÉE (celle que Excel a enregistrée) ; une
// formule sans valeur enregistrée est signalée.
//
// Les bancs d'essai comparent ces lecteurs aux fichiers de passation du design (payroll_data.js,
// opex_data.js), extraits de ces mêmes classeurs.
// ============================================================================

const crypto = require('crypto');
let xlsx = null;
try { xlsx = require('xlsx'); } catch { /* bancs d'essai sans xlsx */ }
const { MAPS, computePayroll } = require('./payroll');

const ENTITIES = ['Cluster', 'Xperio'];
const MAX_ABS = 1e10;
const MAX_ROWS = 3000;
const MAX_COLS = 120;
const EPS = 1e-6;
const TRAVEL_KEYS = ['smTravel', 'rdTravel', 'gaTravel'];
// Département d'un contractuel nouveau quand le fichier n'a pas de colonne « Department » : celui
// que le classeur de la CFO donne à ses contractuels (le classeur n'en a pas ; la passation l'a
// déduit de la mappe P&L).
const CON_DEPT_BY_MAP = { 'Recurring COGS': 'SUPPORT', 'Service COGS': 'EXISTING DELIVERY', 'S&M': 'CUSTOMER SUCC', 'R&D': 'DEVELOPMENT', 'G&A': 'IT' };

// ---------------------------------------------------------------------------- utilitaires
const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const isXlsxBuffer = (buf) => Buffer.isBuffer(buf) && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; // « PK » : un .xlsx est un zip
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const sum = (a) => a.reduce((x, y) => x + y, 0);
const near = (a, b) => Math.abs(a - b) <= EPS;

// Nombre depuis une cellule : nombre, ou texte « $1,234.50 » / « (1 234) » ; `pct` : « 40% » → 0,4.
// null = vide ; NaN = illisible.
function toNum(v, pct = false) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'boolean' || v instanceof Date) return NaN;
  let s = String(v).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const isPct = /%\s*$/.test(s);
  s = s.replace(/[$%\s ]/g, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return NaN;
  let n = Number(s);
  if (neg) n = -n;
  if (isPct && pct) n /= 100;
  return Number.isFinite(n) ? n : NaN;
}

// Lecture d'un classeur : feuilles → { name, ws, rows, cell(r, c) }. Refuse l'énorme.
function openBook(buffer) {
  if (!xlsx) throw Object.assign(new Error('xlsx_unavailable'), { code: 'xlsx_unavailable' });
  if (!isXlsxBuffer(buffer)) throw Object.assign(new Error('not_xlsx'), { code: 'not_xlsx' });
  let wb;
  try { wb = xlsx.read(buffer, { type: 'buffer', cellDates: true }); } catch { throw Object.assign(new Error('unreadable'), { code: 'unreadable' }); }
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const ref = ws && ws['!ref'];
    if (!ref) return { name, ws, rows: [], cell: () => null, addr: () => '', r0: 0 };
    const rg = xlsx.utils.decode_range(ref);
    if (rg.e.r - rg.s.r + 1 > MAX_ROWS || rg.e.c - rg.s.c + 1 > MAX_COLS) throw Object.assign(new Error('too_large'), { code: 'file_too_large' });
    const addr = (r, c) => xlsx.utils.encode_cell({ r: r + rg.s.r, c: c + rg.s.c });
    const cell = (r, c) => ws[addr(r, c)] || null;
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    return { name, ws, rows, cell, addr, r0: rg.s.r };
  });
  return { sheets };
}

// Valeur d'une cellule + anomalies : formule sans valeur enregistrée, cellule en erreur.
function readCell(sh, r, c, sink, where) {
  const x = sh.cell(r, c);
  if (!x) return null;
  if (x.t === 'e') { sink.push({ sheet: sh.name, row: r + 1 + sh.r0, code: 'cell_error', value: where || sh.addr(r, c) }); return null; }
  if (x.f && (x.v === undefined || x.v === null)) {
    sink.push({ sheet: sh.name, row: r + 1 + sh.r0, code: 'no_cached_value', value: sh.addr(r, c) });
    return null;
  }
  return x.v === undefined ? null : x.v;
}

const findHeaderRow = (sh, tests, scan = 120) => {
  for (let r = 0; r < Math.min(sh.rows.length, scan); r++) {
    const cells = (sh.rows[r] || []).map((v) => norm(typeof v === 'string' ? v : ''));
    const cols = {};
    let ok = true;
    for (const [k, re, required] of tests) {
      const c = cells.findIndex((h, i) => h && re.test(h) && !Object.values(cols).includes(i));
      if (c >= 0) cols[k] = c; else if (required) { ok = false; break; }
    }
    if (ok) return { r, cols };
  }
  return null;
};

const pickSheets = (book, nameRe) => [...book.sheets.filter((s) => nameRe.test(s.name)), ...book.sheets.filter((s) => !nameRe.test(s.name))];

// ---------------------------------------------------------------------------- effectif
// → { employees, contractors, hasEmployees, hasContractors, hasContractorDept, errors, warnings, sheets }
// errors : { sheet, row, code, value? } — bloquent la confirmation ; warnings : idem, ne bloquent pas.
function parseRoster(buffer) {
  const book = openBook(buffer);
  const errors = [], warnings = [];
  const out = { employees: [], contractors: [], hasEmployees: false, hasContractors: false, hasContractorDept: false, errors, warnings, sheets: {} };

  // ---- employés
  const empTests = [
    ['ent', /^entity$/, true], ['dept', /^department$/, true], ['name', /^(employee|name)$/, true],
    ['salary', /annual salary|^salary$/, true], ['alloc', /allocation/, true], ['map', /p&l mapping|^mapping$/, true],
    ['burden', /burden/, false],
  ];
  for (const sh of pickSheets(book, /payroll|employee/i)) {
    const h = findHeaderRow(sh, empTests);
    if (!h) continue;
    out.hasEmployees = true;
    out.sheets.employees = sh.name;
    const { cols } = h;
    const seen = new Map();
    for (let r = h.r + 1; r < sh.rows.length; r++) {
      const raw = sh.rows[r] || [];
      const first = norm(raw[0]);
      if (/^total/.test(first)) break;
      const get = (k) => readCell(sh, r, cols[k], warnings);
      const entRaw = clean(raw[cols.ent]), nameRaw = clean(raw[cols.name]);
      if (!entRaw && !nameRaw) continue;
      const row = r + 1 + sh.r0;
      const err = (code, value) => errors.push({ sheet: sh.name, row, code, ...(value !== undefined ? { value: String(value) } : {}) });
      const before = errors.length;
      const ent = ENTITIES.find((e) => norm(e) === norm(entRaw));
      if (!ent) err('bad_ent', entRaw);
      const dept = clean(get('dept')).toUpperCase();
      if (!dept) err('bad_dept'); else if (dept.length > 60) err('too_long', 'dept');
      const name = clean(get('name'));
      if (!name) err('bad_name'); else if (name.length > 120) err('too_long', 'name');
      const salary = toNum(get('salary'));
      if (salary == null || Number.isNaN(salary) || salary < 0 || salary >= MAX_ABS) err('bad_salary', raw[cols.salary]);
      const alloc = toNum(get('alloc'), true);
      if (alloc == null || Number.isNaN(alloc) || alloc < 0 || alloc > 1) err('bad_alloc', raw[cols.alloc]);
      const mapRaw = clean(get('map'));
      const map = MAPS.find((m) => norm(m) === norm(mapRaw));
      if (!map) err('unknown_map', mapRaw);
      if (errors.length > before) continue;
      const p = { ent, dept, name, salary, alloc, map, row };
      const k = employeeKey(p);
      if (seen.has(k)) warnings.push({ sheet: sh.name, row, code: 'duplicate_name', value: `${ent} / ${dept} / ${name} (${seen.get(k)})` });
      else seen.set(k, row);
      out.employees.push(p);
    }
    break;
  }

  // ---- contractuels
  const conTests = [
    ['co', /^company$/, true], ['name', /^name$/, true], ['svc', /^service/, true], ['rate', /hourly rate|^rate$/, false],
    ['hours', /hours/, false], ['map', /p&l mapping|^mapping$/, true], ['dept', /^department$/, false],
  ];
  for (const sh of pickSheets(book, /contractor/i)) {
    const h = findHeaderRow(sh, conTests);
    if (!h) continue;
    out.hasContractors = true;
    out.sheets.contractors = sh.name;
    const { cols } = h;
    out.hasContractorDept = cols.dept != null;
    // Le montant mensuel : la colonne qui SUIT « P&L mapping » (Aug-26 dans le classeur de la CFO,
    // « Monthly amount » dans notre modèle).
    const amtCol = cols.map + 1;
    const seen = new Map();
    for (let r = h.r + 1; r < sh.rows.length; r++) {
      const raw = sh.rows[r] || [];
      if (/^total/.test(norm(raw[0])) || /^total/.test(norm(raw[1]))) break;
      const get = (k) => readCell(sh, r, cols[k], warnings);
      const coRaw = clean(raw[cols.co]), nameRaw = clean(raw[cols.name]);
      if (!coRaw && !nameRaw) continue;
      const row = r + 1 + sh.r0;
      const err = (code, value) => errors.push({ sheet: sh.name, row, code, ...(value !== undefined ? { value: String(value) } : {}) });
      const before = errors.length;
      const co = clean(get('co')), name = clean(get('name')), svc = clean(get('svc'));
      if (co.length > 120 || name.length > 120) err('too_long', 'name');
      if (svc.length > 200) err('too_long', 'svc');
      const mapRaw = clean(get('map'));
      const map = MAPS.find((m) => norm(m) === norm(mapRaw));
      if (!map) err('unknown_map', mapRaw);
      let amt = toNum(readCell(sh, r, amtCol, warnings));
      if (amt == null) { amt = 0; warnings.push({ sheet: sh.name, row, code: 'empty_amount', value: `${co} ${name}`.trim() }); }
      if (Number.isNaN(amt) || amt < 0 || amt >= MAX_ABS) err('bad_amount', raw[amtCol]);
      const num = (k) => {
        if (cols[k] == null) return 0;
        const v = toNum(get(k));
        if (v == null) return 0;
        if (Number.isNaN(v) || v < 0 || v >= MAX_ABS) { err(k === 'rate' ? 'bad_rate' : 'bad_hours', raw[cols[k]]); return 0; }
        return v;
      };
      const rate = num('rate'), hours = num('hours');
      let dept = cols.dept != null ? clean(get('dept')).toUpperCase() : '';
      if (dept.length > 60) { err('too_long', 'dept'); dept = ''; }
      if (errors.length > before) continue;
      const p = { co, name, svc, rate, hours, amt, map, dept: dept || (CON_DEPT_BY_MAP[map] || ''), deptFromFile: !!dept, row };
      const k = contractorKey(p);
      if (seen.has(k)) warnings.push({ sheet: sh.name, row, code: 'duplicate_name', value: `${co} / ${name} / ${svc} (${seen.get(k)})` });
      else seen.set(k, row);
      out.contractors.push(p);
    }
    break;
  }

  if (!out.hasEmployees && !out.hasContractors) errors.unshift({ sheet: null, row: 0, code: 'no_roster_tables' });
  else {
    if (!out.hasEmployees) warnings.push({ sheet: null, row: 0, code: 'no_employee_table' });
    if (!out.hasContractors) warnings.push({ sheet: null, row: 0, code: 'no_contractor_table' });
  }
  if (out.hasEmployees && !out.employees.length && !errors.length) errors.push({ sheet: out.sheets.employees, row: 0, code: 'empty_table' });
  return out;
}

// Clés de rapprochement : employé = (entité, département, nom) normalisés ; contractuel =
// (entreprise, nom, service). Les clés « lâches » (sans département / sans service) servent à
// reconnaître une personne qui a changé de département ou de service au lieu d'une sortie + une arrivée.
const employeeKey = (e) => `${norm(e.ent)}|${norm(e.dept)}|${norm(e.name)}`;
const employeeLoose = (e) => `${norm(e.ent)}|${norm(e.name)}`;
const contractorKey = (c) => `${norm(c.co)}|${norm(c.name)}|${norm(c.svc)}`;
const contractorLoose = (c) => `${norm(c.co)}|${norm(c.name)}`;

// Appariement : 1) clé stricte (les doublons s'apparient dans l'ordre) ; 2) clé lâche entre les
// restes, seulement quand elle est unique des deux côtés.
function pair(cur, file, keyFn, looseFn) {
  const pairs = [];
  const usedC = new Set(), usedF = new Set();
  const queue = new Map();
  cur.forEach((c, i) => { const k = keyFn(c); (queue.get(k) || queue.set(k, []).get(k)).push(i); });
  file.forEach((f, j) => {
    const q = queue.get(keyFn(f));
    if (q && q.length) { const i = q.shift(); usedC.add(i); usedF.add(j); pairs.push({ cur: cur[i], file: f, loose: false }); }
  });
  const group = (list, used, fn) => {
    const m = new Map();
    list.forEach((x, i) => { if (!used.has(i)) (m.get(fn(x)) || m.set(fn(x), []).get(fn(x))).push(i); });
    return m;
  };
  const gc = group(cur, usedC, looseFn), gf = group(file, usedF, looseFn);
  for (const [k, ci] of gc) {
    const fj = gf.get(k);
    if (ci.length === 1 && fj && fj.length === 1) { usedC.add(ci[0]); usedF.add(fj[0]); pairs.push({ cur: cur[ci[0]], file: file[fj[0]], loose: true }); }
  }
  return {
    pairs,
    added: file.filter((_, j) => !usedF.has(j)),
    missing: cur.filter((_, i) => !usedC.has(i)),
  };
}

// ---- comparaison de l'effectif (rien n'est écrit)
// cur : { employees, contractors } au format de l'API (camelCase). parsed : sortie de parseRoster.
function diffRoster(cur, parsed) {
  const out = { employees: null, contractors: null };
  if (parsed.hasEmployees) {
    const m = pair(cur.employees, parsed.employees, employeeKey, employeeLoose);
    const changed = [], unchanged = [];
    for (const p of m.pairs) {
      const ch = [];
      if (!near(p.cur.salary, p.file.salary)) ch.push({ field: 'salary', before: p.cur.salary, after: p.file.salary });
      if (!near(p.cur.alloc, p.file.alloc)) ch.push({ field: 'alloc', before: p.cur.alloc, after: p.file.alloc });
      if (p.cur.map !== p.file.map) ch.push({ field: 'map', before: p.cur.map, after: p.file.map });
      if (norm(p.cur.dept) !== norm(p.file.dept)) ch.push({ field: 'dept', before: p.cur.dept, after: p.file.dept });
      const rec = { id: p.cur.id, ent: p.file.ent, dept: p.file.dept, name: p.file.name, changes: ch, file: p.file, cur: p.cur };
      (ch.length ? changed : unchanged).push(rec);
    }
    out.employees = { pairs: m.pairs, added: m.added, missing: m.missing, changed, unchanged };
  }
  if (parsed.hasContractors) {
    const m = pair(cur.contractors, parsed.contractors, contractorKey, contractorLoose);
    const changed = [], unchanged = [];
    for (const p of m.pairs) {
      const ch = [];
      if (!near(p.cur.amt, p.file.amt)) ch.push({ field: 'amt', before: p.cur.amt, after: p.file.amt });
      if (!near(p.cur.rate || 0, p.file.rate || 0)) ch.push({ field: 'rate', before: p.cur.rate || 0, after: p.file.rate });
      if (!near(p.cur.hours || 0, p.file.hours || 0)) ch.push({ field: 'hours', before: p.cur.hours || 0, after: p.file.hours });
      if (p.cur.map !== p.file.map) ch.push({ field: 'map', before: p.cur.map, after: p.file.map });
      if (norm(p.cur.svc) !== norm(p.file.svc)) ch.push({ field: 'svc', before: p.cur.svc, after: p.file.svc });
      if (p.file.deptFromFile && norm(p.cur.dept) !== norm(p.file.dept)) ch.push({ field: 'dept', before: p.cur.dept, after: p.file.dept });
      const rec = { id: p.cur.id, co: p.file.co, name: p.file.name, svc: p.file.svc, changes: ch, file: p.file, cur: p.cur };
      (ch.length ? changed : unchanged).push(rec);
    }
    out.contractors = { pairs: m.pairs, added: m.added, missing: m.missing, changed, unchanged };
  }
  return out;
}

// Totaux FY2027 (12 mois) de la paie avec les réglages globaux ACTUELS : lignes de l'API → totaux.
function payrollTotals(employees, contractors, globals) {
  const p = computePayroll(employees, contractors, globals);
  const payroll = sum(p.emp.map((e) => sum(e.m)));
  const con = sum(p.con.map((c) => sum(c.m)));
  return { headcount: employees.length, contractorCount: contractors.length, payroll, contractors: con, total: payroll + con };
}

// L'effectif tel qu'il serait après application (mêmes règles que l'écriture : les surcharges par
// personne et les mois d'arrivée / de départ sont gardés).
function rosterAfter(cur, d, removeMissing) {
  const E = cur.employees.map((e) => ({ ...e }));
  const C = cur.contractors.map((c) => ({ ...c }));
  const byId = (list) => new Map(list.map((x) => [x.id, x]));
  if (d.employees) {
    const m = byId(E);
    for (const p of d.employees.pairs) Object.assign(m.get(p.cur.id), { salary: p.file.salary, alloc: p.file.alloc, map: p.file.map, dept: p.file.dept });
    for (const a of d.employees.added) E.push({ id: null, ent: a.ent, dept: a.dept, name: a.name, salary: a.salary, alloc: a.alloc, map: a.map, raisePct: null, raiseMo: null, burdenPct: null, startMo: 0, endMo: null });
  }
  if (d.contractors) {
    const m = byId(C);
    for (const p of d.contractors.pairs) {
      Object.assign(m.get(p.cur.id), { amt: p.file.amt, rate: p.file.rate, hours: p.file.hours, map: p.file.map, svc: p.file.svc });
      if (p.file.deptFromFile) m.get(p.cur.id).dept = p.file.dept;
    }
    for (const a of d.contractors.added) C.push({ id: null, co: a.co, name: a.name, svc: a.svc, rate: a.rate, hours: a.hours, amt: a.amt, map: a.map, dept: a.dept, startMo: 0, endMo: null });
  }
  const drop = (list, miss) => { const ids = new Set(miss.map((x) => x.id)); return list.filter((x) => !ids.has(x.id)); };
  return {
    employees: removeMissing && d.employees ? drop(E, d.employees.missing) : E,
    contractors: removeMissing && d.contractors ? drop(C, d.contractors.missing) : C,
  };
}

// Empreinte de l'effectif + réglages de paie : sert de « base » (concurrence optimiste) — elle ne
// bouge que si quelqu'un touche vraiment à l'effectif, pas à chaque enregistrement d'une autre section.
function rosterFingerprint(cur, globals) {
  return sha256(JSON.stringify([cur.employees, cur.contractors, globals]));
}

// ---------------------------------------------------------------------------- OPEX
const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FIRST_YEAR = 2026;
const N_MONTHS = 36;

const sectionKey = (s) => {
  const n = norm(s);
  if (/sales|marketing/.test(n)) return 'sm';
  if (/research|r&d/.test(n)) return 'rd';
  if (/general|admin|g&a/.test(n)) return 'ga';
  return null;
};

// En-tête de mois → { y, m } ou null. Date Excel (minuit local, tolérance de 6 h) ou « Dec 2026 » / « Jan-26 ».
function monthOf(v) {
  if (v instanceof Date && !Number.isNaN(+v)) { const d = new Date(+v + 6 * 3600e3); return { y: d.getFullYear(), m: d.getMonth() }; }
  if (typeof v === 'string') {
    const m = v.trim().toLowerCase().match(/^([a-z]{3})[a-z]*\.?[\s\-'/]*(\d{2}|\d{4})$/);
    if (m && MONTHS_EN.includes(m[1])) return { y: m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]), m: MONTHS_EN.indexOf(m[1]) };
  }
  return null;
}

// Formule de sous-total : seulement des références à la MÊME colonne (SUM(B7:B11), B12+B16…).
function isSubtotalFormula(f, colLetter) {
  if (!f || /!/.test(f)) return false;
  const refs = f.match(/\$?[A-Z]{1,3}\$?\d+/g);
  if (!refs || !refs.length) return false;
  return refs.every((r) => r.replace(/[$\d]/g, '') === colLetter) && /^(SUM\(|[A-Z$])/.test(f);
}

// → { rows:[{ section, sectionLabel, label, norm, row, v:[36], subtotalFormula }], errors, warnings }
function parseOpex(buffer) {
  const book = openBook(buffer);
  const errors = [], warnings = [];
  let found = null;
  for (const sh of pickSheets(book, /^opex$/i)) {
    // Ligne des mois : au moins 36 cellules d'en-tête consécutives à partir de la colonne B.
    for (let r = 0; r < Math.min(sh.rows.length, 30); r++) {
      const row = sh.rows[r] || [];
      let n = 0;
      while (n < row.length - 1 && row[1 + n] != null && row[1 + n] !== '') n++;
      if (n >= N_MONTHS) { found = { sh, r }; break; }
    }
    if (found) break;
  }
  if (!found) return { rows: [], sheet: null, errors: [{ sheet: null, row: 0, code: 'no_opex_table' }], warnings };
  const { sh, r: hr } = found;
  const hdr = sh.rows[hr];
  let bad = 0;
  for (let i = 0; i < N_MONTHS; i++) {
    const mo = monthOf(hdr[1 + i]);
    if (!mo) continue; // illisible : toléré (positionnel), mais pas plus de quelques-uns
    const want = { y: FIRST_YEAR + Math.floor(i / 12), m: i % 12 };
    if (mo.y !== want.y || mo.m !== want.m) bad++;
  }
  const unreadable = hdr.slice(1, 1 + N_MONTHS).filter((v) => !monthOf(v)).length;
  if (bad || unreadable > 3) errors.push({ sheet: sh.name, row: hr + 1 + sh.r0, code: 'bad_months', value: bad ? String(bad) : String(unreadable) });
  if (errors.length) return { rows: [], sheet: sh.name, errors, warnings };

  const rows = [];
  let section = null, sectionLabel = null;
  for (let r = hr + 1; r < sh.rows.length; r++) {
    const raw = sh.rows[r] || [];
    const label = clean(raw[0]);
    if (!label) continue;
    const row = r + 1 + sh.r0;
    const cells = raw.slice(1, 1 + N_MONTHS);
    const numeric = cells.filter((v) => v != null && v !== '').length;
    if (!numeric) {
      const k = sectionKey(label);
      if (k) { section = k; sectionLabel = label; } else warnings.push({ sheet: sh.name, row, code: 'blank_line', value: label });
      continue;
    }
    const v = [];
    let ok = true;
    for (let i = 0; i < N_MONTHS; i++) {
      const c = 1 + i;
      const val = readCell(sh, r, c, warnings);
      const x = toNum(val);
      if (x == null) { v.push(0); continue; }
      if (Number.isNaN(x) || Math.abs(x) >= MAX_ABS) { errors.push({ sheet: sh.name, row, code: 'bad_number', value: `${label} / ${sh.addr(r, c)}` }); ok = false; break; }
      v.push(x);
    }
    if (!ok) continue;
    const fcell = sh.cell(r, 1);
    const colLetter = xlsx.utils.encode_col(1);
    rows.push({ section, sectionLabel, label, norm: norm(label), row, v, subtotalFormula: !!(fcell && isSubtotalFormula(fcell.f, colLetter)) });
  }
  if (!rows.length) errors.push({ sheet: sh.name, row: 0, code: 'empty_table' });
  return { rows, sheet: sh.name, errors, warnings };
}

const fy3 = (v) => [sum(v.slice(0, 12)), sum(v.slice(12, 24)), sum(v.slice(24, 36))];

// Les lignes de la référence (items « line ») rapprochées du fichier par (section, nom normalisé).
// reference.opex : [{ t:'sec'|'line'|'sub', name, key, pay, v }].
function diffOpex(reference, parsed) {
  const items = reference.opex || [];
  const lines = new Map(), subs = new Set();
  let sec = null;
  for (const it of items) {
    if (it.t === 'sec') { sec = sectionKey(it.name); continue; }
    const k = `${sec}|${norm(it.name)}`;
    if (it.t === 'line') lines.set(k, { it, sec });
    else subs.add(k);
  }
  const matched = new Map(); // key → parsed row
  const unmatched = [], warnings = [];
  for (const r of parsed.rows) {
    const k = `${r.section}|${r.norm}`;
    const hit = lines.get(k);
    if (hit) {
      if (matched.has(hit.it.key) && subs.has(k)) continue; // ligne et sous-total de même nom (« Meals & Entertainment ») : le 2e rang est le sous-total
      if (matched.has(hit.it.key)) { warnings.push({ sheet: parsed.sheet, row: r.row, code: 'duplicate_line', value: r.label }); unmatched.push({ section: r.sectionLabel, name: r.label, row: r.row, fy: fy3(r.v), duplicate: true }); continue; }
      matched.set(hit.it.key, r);
      continue;
    }
    if (subs.has(k) || r.subtotalFormula) continue;
    unmatched.push({ section: r.sectionLabel, name: r.label, row: r.row, fy: fy3(r.v) });
  }
  const changed = [], unchanged = [], notInFile = [];
  const tot = { before: [0, 0, 0], after: [0, 0, 0], editableFy27: { before: 0, after: 0 } };
  const secLabel = {};
  let cs = null;
  for (const it of items) {
    if (it.t === 'sec') { cs = it.name; continue; }
    if (it.t !== 'line') continue;
    secLabel[it.key] = cs;
    const before = (it.v || Array(N_MONTHS).fill(0)).map((x) => x || 0);
    const special = it.pay ? 'payroll' : TRAVEL_KEYS.includes(it.key) ? 'travel' : null;
    const f = matched.get(it.key);
    const after = f ? f.v : before;
    const b3 = fy3(before), a3 = fy3(after);
    for (let i = 0; i < 3; i++) { tot.before[i] += b3[i]; tot.after[i] += a3[i]; }
    if (!special) { tot.editableFy27.before += b3[1]; tot.editableFy27.after += a3[1]; }
    if (!f) { notInFile.push({ key: it.key, name: it.name, section: cs }); continue; }
    const diff = before.some((x, i) => !near(x, after[i]));
    const rec = { key: it.key, name: it.name, section: cs, special, row: f.row, before: b3, after: a3, months: before.filter((x, i) => !near(x, after[i])).length, values: after };
    (diff ? changed : unchanged).push(rec);
  }
  return { changed, unchanged, unmatched, notInFile, totals: tot, warnings };
}

// Empreinte de la partie de la référence que l'import OPEX peut modifier (base de concurrence).
const opexFingerprint = (reference) => sha256(JSON.stringify((reference.opex || []).map((it) => [it.key, it.v || null])));

// Référence avec les nouvelles valeurs de base posées sur les lignes rapprochées ; clés, `pay`,
// structure et ordre ne bougent JAMAIS.
function applyOpex(reference, d) {
  const byKey = new Map(d.changed.map((c) => [c.key, c.values]));
  return { ...reference, opex: reference.opex.map((it) => (it.t === 'line' && byKey.has(it.key) ? { ...it, v: byKey.get(it.key) } : it)) };
}

// ---------------------------------------------------------------------------- modèles Excel
const FR = { rosterNotes: [
  'Modèle d\'import de l\'effectif — Sales Hub (Finance).',
  'Cet onglet est ignoré à l\'import. Les onglets « Payroll » et « Contractors » sont relus tels quels.',
  'Employés : entité (Cluster / Xperio), département, nom, salaire annuel, % d\'allocation (0 à 1), mappe P&L. Ne pas changer les en-têtes.',
  'Contractuels : le montant mensuel est la colonne « Monthly amount » (celle qui suit « P&L mapping »). « Department » est facultatif.',
  'Les formules sont lues en valeur calculée : enregistrer le fichier dans Excel avant de l\'importer.',
  'Une personne est reconnue par (entité, département, nom) ; un contractuel par (entreprise, nom, service).',
] };
const EN = { rosterNotes: [
  'Roster import template — Sales Hub (Finance).',
  'This sheet is ignored on import. The "Payroll" and "Contractors" sheets are read back as-is.',
  'Employees: entity (Cluster / Xperio), department, name, annual salary, allocation % (0 to 1), P&L mapping. Do not change the headers.',
  'Contractors: the monthly amount is the "Monthly amount" column (the one after "P&L mapping"). "Department" is optional.',
  'Formulas are read as calculated values: save the file in Excel before importing it.',
  'A person is matched by (entity, department, name); a contractor by (company, name, service).',
] };

function writeBook(sheets) {
  if (!xlsx) throw new Error('xlsx_unavailable');
  const wb = xlsx.utils.book_new();
  for (const s of sheets) {
    const ws = xlsx.utils.aoa_to_sheet(s.rows, { cellDates: true });
    if (s.cols) ws['!cols'] = s.cols.map((w) => ({ wch: w }));
    if (s.fmt) for (const [addr, z] of Object.entries(s.fmt)) if (ws[addr]) ws[addr].z = z;
    xlsx.utils.book_append_sheet(wb, ws, s.name);
  }
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Effectif courant (format API) → classeur relu à l'identique par parseRoster.
function rosterTemplate(cur, globals, lang = 'en') {
  const notes = (lang === 'fr' ? FR : EN).rosterNotes;
  const burden = (globals && Number.isFinite(Number(globals.burden)) ? Number(globals.burden) : 17.5) / 100;
  const first = 5; // première ligne de données (1-based)
  const empRows = [
    ['Headcount & Payroll'], [notes[0]], [],
    ['Entity', 'Department', 'Employee', 'Annual salary', 'Budget allocation %', 'P&L mapping', 'Included annual', 'Payroll burden'],
    ...cur.employees.map((e, i) => [e.ent, e.dept, e.name, e.salary, e.alloc, e.map, { t: 'n', v: e.salary * e.alloc, f: `D${first + i}*E${first + i}` }, e.burdenPct != null ? e.burdenPct / 100 : burden]),
  ];
  const conRows = [
    ['Contractor Detail'], [notes[0]], [],
    ['Company', 'Name', 'Service', 'Hourly rate', 'Hours', 'Invoiced', 'Paid', 'P&L mapping', 'Monthly amount', 'Department'],
    ...cur.contractors.map((c) => [c.co, c.name, c.svc, c.rate || 0, c.hours || 0, c.amt, 'Yes', c.map, c.amt, c.dept || '']),
  ];
  return writeBook([
    { name: 'Payroll', rows: empRows, cols: [10, 20, 30, 14, 18, 16, 14, 14], fmt: Object.fromEntries(cur.employees.flatMap((_, i) => [[`E${first + i}`, '0%'], [`H${first + i}`, '0.0%']])) },
    { name: 'Contractors', rows: conRows, cols: [28, 26, 34, 12, 10, 12, 8, 16, 16, 18] },
    { name: 'Notes', rows: notes.map((n) => [n]), cols: [140] },
  ]);
}

// Référence OPEX → classeur au format de Book4 (sections, lignes, sous-totaux en valeurs).
function opexTemplate(reference) {
  const rows = [['CLUSTER POS'], ['Opex Details'], []];
  const fyRow = [null], mRow = [null];
  for (let i = 0; i < N_MONTHS; i++) {
    fyRow.push(i % 12 === 0 ? `FY ${26 + i / 12}` : null);
    mRow.push(new Date(FIRST_YEAR + Math.floor(i / 12), i % 12, 1, 12));
  }
  rows.push(fyRow, mRow);
  const z = () => Array(N_MONTHS).fill(0);
  let subAcc = z(), secAcc = z(), totAcc = z();
  const add = (a, v) => a.map((x, i) => x + (v[i] || 0));
  for (const it of reference.opex || []) {
    if (it.t === 'sec') { rows.push([it.name]); continue; }
    if (it.t === 'line') {
      const v = (it.v || z()).map((x) => x || 0);
      rows.push([it.name, ...v]);
      subAcc = add(subAcc, v);
      continue;
    }
    if (it.key === 'opTot') { rows.push([it.name, ...totAcc]); continue; }
    if (/^Total /.test(it.name)) { rows.push([it.name, ...secAcc]); totAcc = add(totAcc, secAcc); secAcc = z(); rows.push([]); continue; }
    rows.push([it.name, ...subAcc]);
    secAcc = add(secAcc, subAcc);
    subAcc = z();
  }
  const fmt = {};
  for (let i = 0; i < N_MONTHS; i++) fmt[xlsx.utils.encode_cell({ r: 4, c: 1 + i })] = 'mmm-yy';
  return writeBook([{ name: 'OPEX', rows, cols: [40, ...Array(N_MONTHS).fill(12)], fmt }]);
}

module.exports = {
  ENTITIES, CON_DEPT_BY_MAP, N_MONTHS, TRAVEL_KEYS,
  norm, toNum, isXlsxBuffer, sha256, openBook,
  parseRoster, diffRoster, payrollTotals, rosterAfter, rosterFingerprint, employeeKey, contractorKey,
  parseOpex, diffOpex, applyOpex, opexFingerprint, sectionKey, fy3,
  rosterTemplate, opexTemplate,
};
