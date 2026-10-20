// ============================================================================
// Module Finance — Prévisions (lot C) : calculs purs côté serveur, sans base ni HTTP.
//
//   - mois « YYYY-MM » (clé stable de toutes les grilles) ;
//   - investissement en ressources : coût par initiative à partir de l'effectif (lignes
//     nominatives) — calculé ICI pour les usagers sans `finance:payroll`, qui ne reçoivent que
//     les totaux. ⚠️ GARDER IDENTIQUE à computeInvestment() de
//     frontend/src/pages/Finance/Forecasts/engine.ts (le banc d'essai du frontend compare les deux) ;
//   - lecture des feuilles `V2` / `Payments Conversion` du classeur de la CFO.
// ============================================================================

const YM_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const isYm = (s) => typeof s === 'string' && YM_RE.test(s);
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`; // m = 1..12
const ymParts = (s) => ({ y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)) });
const ymIndex = (s) => { const { y, m } = ymParts(s); return y * 12 + (m - 1); };
const ymFromIndex = (i) => ym(Math.floor(i / 12), (i % 12) + 1);
const ymAdd = (s, k) => ymFromIndex(ymIndex(s) + k);
const yearMonths = (y) => Array.from({ length: 12 }, (_, i) => ym(y, i + 1));
const r2 = (v) => Math.round(v * 100) / 100;

// Une cellule de date Excel (lue par SheetJS avec cellDates) → « YYYY-MM ». Les dates du classeur
// sont des minuits LOCAUX (2026-08-01T04:00Z) : on décale de 12 h avant de lire le mois UTC, ce
// qui tient pour tout fuseau entre −12 h et +12 h.
function cellYm(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const d = new Date(v.getTime() + 12 * 3600 * 1000);
    return ym(d.getUTCFullYear(), d.getUTCMonth() + 1);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (isYm(s)) return s;
    const m = /^(\d{4})-(\d{2})-\d{2}/.exec(s);
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2]}`;
  }
  return null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/[\s,$]/g, ''))) ? Number(v.replace(/[\s,$]/g, '')) : null));
const text = (v) => (v == null ? '' : String(v).trim());

// ---------------------------------------------------------------------------- investissement
// Coût mensuel d'une personne = montant de l'horaire × allocation % (100 par défaut : les montants
// du classeur sont déjà ceux de l'initiative).
const personCost = (p, k) => ((p.monthly && Number(p.monthly[k])) || 0) * ((p.alloc == null ? 100 : Number(p.alloc)) / 100);

/**
 * inv = { months: [ym], initiatives: [{ id, name, capPct, other: {ym: n} }], returns: {ym: n} }
 * people = [{ id, type, initiativeId, alloc, monthly: {ym: n} }] (ou null : on n'a que les totaux)
 * → coût par initiative et par mois, « non affecté », totaux, effectif (compte et ETP).
 */
function computeInvestment(inv, people) {
  const months = (inv && inv.months) || [];
  const inits = (inv && inv.initiatives) || [];
  const ids = new Set(inits.map((i) => i.id));
  const ppl = people || [];
  const zero = () => Object.fromEntries(months.map((k) => [k, 0]));
  const rows = inits.map((it) => {
    const mine = ppl.filter((p) => p.initiativeId === it.id);
    const payroll = zero(), other = zero(), cost = zero();
    for (const k of months) {
      payroll[k] = mine.reduce((s, p) => s + personCost(p, k), 0);
      other[k] = (it.other && Number(it.other[k])) || 0;
      cost[k] = payroll[k] + other[k];
    }
    const emp = mine.filter((p) => p.type === 'Employee');
    return {
      id: it.id, name: it.name, capPct: it.capPct == null ? null : Number(it.capPct),
      employees: emp.length, contractors: mine.length - emp.length,
      fte: emp.reduce((s, p) => s + (p.alloc == null ? 100 : Number(p.alloc)) / 100, 0),
      payroll, other, cost,
    };
  });
  const orphans = ppl.filter((p) => !p.initiativeId || !ids.has(p.initiativeId));
  const unassigned = zero();
  for (const k of months) unassigned[k] = orphans.reduce((s, p) => s + personCost(p, k), 0);
  const total = zero();
  for (const k of months) total[k] = rows.reduce((s, r) => s + r.cost[k], 0) + unassigned[k];
  const emp = ppl.filter((p) => p.type === 'Employee');
  return {
    months, initiatives: rows, unassigned, unassignedCount: orphans.length, total,
    headcount: { employees: emp.length, contractors: ppl.length - emp.length, fte: emp.reduce((s, p) => s + (p.alloc == null ? 100 : Number(p.alloc)) / 100, 0) },
  };
}

// ---------------------------------------------------------------------------- lecture du classeur
const PROGRAM_SHEETS = { v2: ['V2'], payments: ['Payments Conversion', 'Payments'] };

/**
 * Une feuille au format de `V2` / `Payments Conversion` :
 *   ligne d'en-tête « Type | Name | P&L Mapping | Base Annual / Monthly | <mois…> | totaux »
 *   lignes Employee / Contractor ; ligne TOTAL ; (Payments) ligne « Revenue » = rendement.
 * → { months, people, total, returns, returnLabel, warnings } ou { error }.
 */
function parseProgramSheet(rows) {
  const hi = rows.findIndex((r) => r && text(r[0]).toLowerCase() === 'type' && text(r[1]).toLowerCase() === 'name');
  if (hi < 0) return { error: 'header_not_found' };
  const head = rows[hi];
  const cols = [];
  head.forEach((v, j) => { const k = cellYm(v); if (k) cols.push({ j, k }); });
  if (!cols.length) return { error: 'no_month_columns' };
  const months = cols.map((c) => c.k);
  if (new Set(months).size !== months.length) return { error: 'duplicate_months' };
  for (let i = 1; i < months.length; i++) if (ymIndex(months[i]) !== ymIndex(months[i - 1]) + 1) return { error: 'months_not_consecutive' };
  const people = [];
  let total = null, returns = null, returnLabel = null;
  const warnings = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const kind = text(r[0]);
    const lk = kind.toLowerCase();
    const series = () => Object.fromEntries(cols.map((c) => [c.k, num(r[c.j]) || 0]));
    if (lk === 'employee' || lk === 'contractor') {
      const name = text(r[1]);
      if (!name) { warnings.push({ row: i + 1, code: 'missing_name' }); continue; }
      people.push({ type: lk === 'employee' ? 'Employee' : 'Contractor', name: name.slice(0, 120), map: text(r[2]).slice(0, 60), base: num(r[3]), monthly: series() });
    } else if (lk === 'total' && total == null) {
      total = series();
    } else if (lk === 'revenue' && returns == null) {
      returns = series();
      returnLabel = text(r[1]).slice(0, 120) || null;
    }
  }
  if (!people.length) return { error: 'no_people' };
  // Contrôle : Σ des personnes = ligne TOTAL du classeur, mois par mois (au cent).
  if (total) {
    for (const k of months) {
      const s = people.reduce((a, p) => a + p.monthly[k], 0);
      if (Math.abs(s - total[k]) > 0.01) warnings.push({ code: 'total_mismatch', month: k, sum: r2(s), total: r2(total[k]) });
    }
  } else warnings.push({ code: 'no_total_row' });
  return { months, people, total, returns, returnLabel, warnings };
}

/** Classeur entier → un programme par feuille reconnue. */
function parseInvestmentWorkbook(wb) {
  const out = {};
  for (const [program, names] of Object.entries(PROGRAM_SHEETS)) {
    const name = names.find((n) => wb.sheetNames.includes(n));
    if (!name) continue;
    const p = parseProgramSheet(wb.rows(name));
    out[program] = { sheet: name, ...p };
  }
  return out;
}

const sumMonths = (series, months) => months.reduce((s, k) => s + ((series && Number(series[k])) || 0), 0);

module.exports = {
  isYm, ym, ymParts, ymIndex, ymFromIndex, ymAdd, yearMonths, cellYm, num, text, r2,
  computeInvestment, parseProgramSheet, parseInvestmentWorkbook, sumMonths, PROGRAM_SHEETS,
};
