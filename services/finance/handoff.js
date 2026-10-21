// ============================================================================
// Module Finance — lecture du paquet de passation du design (design/finance).
//
// Le paquet contient les données de la CFO, extraites de ses classeurs Excel : budget
// (budget_data.js), paie (payroll_data.js — VRAIS noms et salaires), OPEX (opex_data.js), et
// des constantes écrites en dur dans le prototype (valeurs par défaut des drivers, soldes de
// départ de décembre 2026, colonne « Total réel 2026 »).
//
// Ce fichier ne contient AUCUNE donnée : il lit le dossier qu'on lui donne. Il sert à
//   - l'import ponctuel en base (services/finance/import.js) ;
//   - aux bancs d'essai, qui comparent notre moteur au prototype lui-même.
// Les données ne doivent jamais être commitées (le frontend est public sur Netlify).
// ============================================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROTO = 'Finance Module Prototype.dc.html';

function readDataFiles(dir) {
  const ctx = { window: {} };
  vm.createContext(ctx);
  for (const f of ['budget_data.js', 'payroll_data.js', 'opex_data.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  }
  return ctx.window;
}

// Évalue un littéral objet `const NAME = { … };` tiré du code du prototype.
function literal(src, name) {
  const m = src.match(new RegExp(`const ${name} = (\\{[^;]*\\});`));
  if (!m) throw new Error(`constante ${name} introuvable dans le prototype`);
  return vm.runInNewContext(`(${m[1]})`);
}

// Soldes de départ (décembre 2026) : `let canEnd = 2898, usaEnd = 153, …;` au-dessus de la boucle.
function startBalances(src) {
  const m = src.match(/let (canEnd = [^;]*);/);
  if (!m) throw new Error('soldes de départ introuvables dans le prototype');
  const out = {};
  for (const part of m[1].split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    out[k] = Number(v);
    if (!Number.isFinite(out[k])) throw new Error(`solde de départ illisible : ${part}`);
  }
  return out;
}

// Les catégories du budget (budget_data.js) regroupées sous les deux lignes hors exploitation
// du Budget maître — même table que `catMap` du prototype.
const NON_OP_CATS = {
  income: ['Non-Operating Income', 'Gain on Sale of Division'],
  expense: ['Other Non-Operating Expenses', 'Non-Operating Professional Expenses', 'Exchange Gain or Loss', 'Amortization'],
};
const NON_OP_ROWS = { income: 'Non-operating Income', expense: 'Non-operating Expense' };

function extractHandoff(dir) {
  const src = fs.readFileSync(path.join(dir, PROTO), 'utf8');
  const W = readDataFiles(dir);
  const start = startBalances(src);
  const fy26 = literal(src, 'FY26');
  const a26 = literal(src, 'A26');

  // Valeurs 2026 que le prototype écrit en TEXTE dans les lignes des drivers (« 2,873 », « (6) »…).
  // Ce sont des ouvertures d'AOÛT 2026, pas de janvier : reproduites telles quelles (voir les
  // écarts signalés à la CFO).
  Object.assign(fy26, {
    canBeg: 2873, usaBeg: 180, xpBeg: 578, newAdds: 193, netRoof: -6,
    adyenBeg: 386, adyenNetNew: 90, adyenExist: 135,
    canArpu: start.canArpu, usaArpu: start.usaArpu, xpArpu: start.xpArpu, adyenArpu: start.adyenArpu,
    xpHw2: fy26.xpHw, lic2: fy26.lic, hwCogsPct: 59.6,
  });

  const B = W.BUDGET;
  const consRow = (n) => {
    const r = B.consolidated.find((x) => x.name === n);
    return r ? r.v.slice(6, 18).map((v) => v || 0) : Array(12).fill(0);
  };
  const nonOp = {};
  for (const side of ['income', 'expense']) {
    nonOp[side] = {
      v: consRow(NON_OP_ROWS[side]),
      gl: B.drivers.filter((d) => NON_OP_CATS[side].includes(d.cat))
        .map((d) => ({ name: d.gl + (d.ent === 'Xperio' ? ' · Xperio' : ''), v: d.m.slice(4, 16).map((x) => x || 0) })),
    };
  }

  const reference = {
    v: 1,
    fiscalYear: 2027,
    drvDefaults: literal(src, 'DRV_DEF'),
    start,
    fy26,
    a26: { rev: a26.rev, cogs: a26.cogs, opex: a26.opex },
    opex: W.OPEX.map((it) => ({ t: it.t, name: it.name, key: it.key || null, pay: it.pay || null, v: it.v || null })),
    trips: (W.OPEX_TRIPS || []).map((t) => ({ ...t })),
    nonOp,
  };
  const roster = {
    employees: W.PAYROLL.employees.map((e) => ({ ...e })),
    contractors: W.PAYROLL.contractors.map((c) => ({ ...c })),
  };
  return { reference, roster };
}

// Phase 2 (lot A) : les budgets d'entité Cluster / Xperio et les budgets départementaux, tirés du
// même budget_data.js — références construites par entityBudgets.js (identifiants stables des
// drivers, voir l'en-tête de ce fichier).
function extractEntityBudgets(dir) {
  const { fromHandoffBudget } = require('./entityBudgets');
  return fromHandoffBudget(readDataFiles(dir).BUDGET);
}

// Corrections demandées par la CFO (2026-10-21) PAR-DESSUS le prototype, qui reste lu tel quel
// (les bancs de parité comparent encore au prototype). Appliquées à l'import seulement.
//   · G&A : le prototype omet la ligne « Contractors » alors que le classeur de paie contient un
//     contractuel G&A (Sachin, 2 875 $/mois = 34 500 $/an). La ligne est liée à la paie (« con:G&A »)
//     et se place avant le sous-total « Wages & Salaries ».
function applyCfoAdjustments(reference) {
  const opex = reference.opex.slice();
  if (!opex.some((it) => it.key === 'gaContr')) {
    const at = opex.findIndex((it) => it.key === 'gaSal');
    if (at < 0) throw new Error('applyCfoAdjustments : sous-total gaSal introuvable');
    opex.splice(at, 0, { t: 'line', name: 'Contractors', key: 'gaContr', pay: 'con:G&A', v: Array(36).fill(0) });
  }
  return { ...reference, opex };
}

module.exports = { extractHandoff, extractEntityBudgets, applyCfoAdjustments, PROTO };
