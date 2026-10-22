// ============================================================================
// Module Finance — approbation par driver / ligne OPEX (lot G) : calculs PURS, sans base ni HTTP.
//
//   - la liste des lignes suivies (drivers de revenus et de COGS saisissables, lignes OPEX
//     modifiables) et le responsable SUGGÉRÉ de chacune ;
//   - les valeurs COURANTES d'une ligne (mêmes règles que le navigateur, model.ts) ;
//   - le hachage des valeurs courantes : c'est lui qui rend une approbation « périmée » (stale)
//     dès que la valeur change ;
//   - l'ÉTAT AFFICHÉ, calculé par le serveur (jamais cru du client) ;
//   - l'agrégat de la liste de contrôle (pourcentage pondéré, `ready`).
//
// Aucune donnée de la CFO ici : les lignes viennent de la référence du budget (en base).
// ============================================================================

const crypto = require('crypto');

const TRAVEL_KEYS = ['smTravel', 'rdTravel', 'gaTravel'];

// Drivers saisissables (cellules jaunes) de chaque page, dans l'ordre de rows.ts (frontend) :
// DRV_BOT = revenus, COGS_BOT = COGS. Les lignes alimentées par la paie (supportWages,
// supportContr, nnWages, exWages) ne sont PAS saisissables : elles ne sont pas suivies ici.
// Le banc frontend (test-finance-progress.cjs) compare ces deux listes à rows.ts.
const REVENUE_INPUTS = [
  'intAdds', 'resAdds', 'xpAdds', 'canChurn', 'usaChurn', 'xpChurn', 'canArpuG', 'usaArpuG', 'xpArpuG',
  'contractsG', 'residG', 'convPct', 'adyenResAdds', 'adyenXpAdds', 'adyenChurn', 'adyenTarget', 'adyenArpuG',
  'partnerPayG', 'xpPartnerG', 'newClientPct', 'hwPerNew', 'existClients', 'hwPerExist', 'xpHw', 'cpHw',
  'installPrice', 'discount', 'onsite', 'xpService', 'licG',
];
const COGS_INPUTS = [
  'supportSw', 'merchantFees', 'platformFees', 'hostingG', 'resellerSaasG', 'revShare', 'clusterHwPct',
  'xperioHwPct', 'halukPct', 'onsites', 'jobCost', 'buffer', 'travel', 'svcSw', 'licPct',
  // SH-49 : COGS de service en deux blocs (Net New Delivery / Existing Service).
  'implNnPct', 'svcSwNnPct', 'bufferNnPct', 'nnImplSw', 'exImplSw', 'nnAuto', 'exAuto',
];

// Responsables par défaut (SUGGESTIONS, jamais enregistrées tant que la CFO ne les confirme pas),
// selon la répartition donnée par la CFO le 2026-10-21 :
//   - les ventes (tous les drivers de revenus et l'OPEX S&M) → David ;
//   - TOUS les COGS → Eric, SAUF : hébergement et outils → Fred ; versements récurrents aux
//     revendeurs → David ; frais marchands et frais de plateforme de paiement → Amanda ;
//   - comptabilité et OPEX général (G&A) → Amanda ; R&D → Fred.
// Jerome possède les salaires Admin en G&A : c'est une ligne de PAIE (non saisissable, donc non
// suivie ici) — voir ecarts/progress.md.
const OWNER_SALES = 'David';
const OWNER_DELIVERY = 'Eric';
const OWNER_FINANCE = 'Amanda';
const OWNER_RD = 'Fred';
// Exceptions de la CFO dans les COGS. `hostingG` = hébergement et outils ; `resellerSaasG` et
// `revShare` calculent le versement récurrent (SaaS des revendeurs × partage des revenus).
const COGS_OWNER_EXCEPTIONS = {
  hostingG: 'Fred',
  resellerSaasG: OWNER_SALES,
  revShare: OWNER_SALES,
  merchantFees: OWNER_FINANCE,
  platformFees: OWNER_FINANCE,
};
const OPEX_OWNER = { 'S&M': OWNER_SALES, 'R&D': OWNER_RD, 'G&A': OWNER_FINANCE };
const DEFAULT_DIRECTORY = [OWNER_SALES, 'Jerome', OWNER_DELIVERY, OWNER_FINANCE, OWNER_RD];

const OWNER_MAX = 80;
const MAX_KEYS = 500;

// ---------------------------------------------------------------------------- lignes suivies
const opexDept = (secName) => (secName === 'Sales & Marketing' ? 'S&M' : secName === 'Research & Development' ? 'R&D' : 'G&A');

// Même règle que `editableOpexKeys` de routes.js (non exportée) : ligne sans paie, hors voyages.
// Le test compare les deux (validateSection accepte exactement ces clés).
function editableOpexLines(ref) {
  const out = [];
  let sec = null;
  for (const it of (ref.opex || [])) {
    if (it.t === 'sec') { sec = it.name; continue; }
    if (it.t !== 'line' || !it.key || it.pay || TRAVEL_KEYS.includes(it.key)) continue;
    out.push({ key: it.key, name: it.name, dept: opexDept(sec), item: it });
  }
  return out;
}

/** Lignes suivies du budget : `[{ key: 'drv:…'|'opx:…', kind, id, group, dept, name, suggestedOwner }]`. */
function buildLines(ref) {
  const defs = ref.drvDefaults || {};
  const lines = [];
  for (const [group, ids] of [['revenue', REVENUE_INPUTS], ['cogs', COGS_INPUTS]]) {
    for (const id of ids) {
      if (!Object.prototype.hasOwnProperty.call(defs, id)) continue;
      const owner = group === 'revenue' ? OWNER_SALES : (COGS_OWNER_EXCEPTIONS[id] || OWNER_DELIVERY);
      lines.push({ key: `drv:${id}`, kind: 'driver', id, group, dept: null, name: null, suggestedOwner: owner });
    }
  }
  for (const l of editableOpexLines(ref)) {
    lines.push({ key: `opx:${l.key}`, kind: 'opex', id: l.key, group: 'opex', dept: l.dept, name: l.name, suggestedOwner: OPEX_OWNER[l.dept] });
  }
  return lines;
}

// ---------------------------------------------------------------------------- valeurs courantes
const num = (v) => (+v || 0);

/** 12 valeurs d'un driver : l'ajustement du mois s'il existe, sinon la valeur par défaut (driverInputs, model.ts). */
function driverValues(ref, drvState, id) {
  const o = drvState && drvState.drv && drvState.drv[id];
  const def = (ref.drvDefaults || {})[id];
  return Array.from({ length: 12 }, (_, i) => num(Array.isArray(o) && o[i] != null ? o[i] : def));
}

/** Croissance mensuelle composée à partir de janvier (applyGrowth, model.ts). */
function applyGrowth(base, cells, g) {
  const o = cells || {};
  const has = (i) => o[i] != null;
  if (!g) return base.map((v, i) => (has(i) ? o[i] : v));
  const jan = has(0) ? o[0] : base[0];
  return base.map((_, i) => (has(i) ? o[i] : i === 0 ? jan : jan * Math.pow(1 + g / 100, i)));
}

/** FY2027 d'une ligne OPEX modifiable : base importée (mois 12 à 23 de la référence) + ajustements. */
function opexValues(ref, opexState, key) {
  const it = (ref.opex || []).find((x) => x.t === 'line' && x.key === key);
  const base = Array.from({ length: 12 }, (_, i) => num(((it && it.v) || [])[12 + i]));
  const st = opexState || {};
  return applyGrowth(base, st.opx && st.opx[key], st.opxG && st.opxG[key]);
}
const opexGrowth = (opexState, key) => num(opexState && opexState.opxG && opexState.opxG[key]);

/** { values, growth } courants d'une ligne `drv:…` / `opx:…`, ou ses valeurs par défaut (`state` vide). */
function lineValues(ref, state, line) {
  const st = state || {};
  if (line.kind === 'driver') return { values: driverValues(ref, st.drivers, line.id), growth: 0 };
  return { values: opexValues(ref, st.opex, line.id), growth: opexGrowth(st.opex, line.id) };
}

// ---------------------------------------------------------------------------- hachage
const r6 = (v) => { const x = Math.round(num(v) * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };

/** SHA-256 des 12 valeurs (arrondies au millionième) et du taux de croissance (OPEX). Déterministe. */
function hashValues(values, growth = 0) {
  return crypto.createHash('sha256').update(JSON.stringify({ v: values.map(r6), g: r6(growth) })).digest('hex');
}

// ---------------------------------------------------------------------------- état affiché
const STATES = ['default', 'proposed', 'submitted', 'approved', 'stale'];

/**
 * État affiché d'une ligne, calculé ici (jamais cru du client).
 *   approved  approuvée et la valeur n'a pas bougé depuis ;
 *   stale     approuvée, puis la valeur a changé : à ré-approuver ;
 *   submitted soumise et la valeur n'a pas bougé depuis ;
 *   proposed  modifiée (ou soumise puis modifiée) mais pas soumise ;
 *   default   jamais touchée : valeur par défaut du budget.
 * `row` = ligne de finance_driver_status ou null.
 */
function displayState(row, curHash, defHash) {
  if (row && row.status === 'approved') return curHash === row.approved_hash ? 'approved' : 'stale';
  if (row && row.status === 'submitted' && curHash === row.submitted_hash) return 'submitted';
  return curHash === defHash ? 'default' : 'proposed';
}

// ---------------------------------------------------------------------------- responsables
/** Responsable valide (texte libre ≤ 80 car., sans caractère de contrôle ni chevron) → texte nettoyé, ou null. */
function cleanOwner(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s || s.length > OWNER_MAX || /[\u0000-\u001f\u007f<>]/.test(s)) return null;
  return s;
}

/** Liste de clés : tableau non vide de clés connues, sans doublon, 500 au plus. Sinon un code d'erreur. */
function cleanKeys(keys, known) {
  if (!Array.isArray(keys) || !keys.length) return { error: 'bad_keys' };
  if (keys.length > MAX_KEYS) return { error: 'too_many_keys' };
  const out = [];
  for (const k of keys) {
    if (typeof k !== 'string') return { error: 'bad_keys' };
    if (!known.has(k)) return { error: 'unknown_line', key: k };
    if (!out.includes(k)) out.push(k);
  }
  return { keys: out };
}

// ---------------------------------------------------------------------------- liste de contrôle
// Chaque point : requis ou non, et son poids dans le pourcentage global. DOCUMENTÉ ici et dans
// l'écran : un point obligatoire pèse 2, un point facultatif 1. `ready` = tous les points obligatoires
// (sauf l'approbation finale, qui est l'action qu'il prépare) sont faits ; le pourcentage, lui,
// n'atteint 100 % qu'avec tous les points, approbation finale comprise.
const ITEM_DEFS = [
  { id: 'drivers_revenue', group: 'drivers', required: true },
  { id: 'drivers_cogs', group: 'drivers', required: true },
  { id: 'opex_lines', group: 'drivers', required: true },
  { id: 'drivers_stale', group: 'drivers', required: false },
  { id: 'owners', group: 'drivers', required: true },
  { id: 'roster', group: 'inputs', required: true },
  { id: 'opex_base', group: 'inputs', required: true },
  { id: 'payroll_settings', group: 'inputs', required: true },
  { id: 'kpi_budget', group: 'inputs', required: true },
  { id: 'billing_sync', group: 'data', required: false },
  { id: 'books_connected', group: 'data', required: false },
  { id: 'gl_actuals', group: 'data', required: false },
  { id: 'forecasts', group: 'data', required: false },
  { id: 'managers_deferred', group: 'data', required: false },
  { id: 'managers_amort', group: 'data', required: false },
  { id: 'budget_cluster', group: 'budgets', required: true },
  { id: 'budget_xperio', group: 'budgets', required: true },
  { id: 'budget_departments', group: 'budgets', required: true },
  { id: 'final_approval', group: 'budgets', required: true, final: true },
];
const ITEM_BY_ID = Object.fromEntries(ITEM_DEFS.map((d) => [d.id, d]));
const WEIGHT_REQUIRED = 2;
const WEIGHT_OPTIONAL = 1;
const ITEM_STATES = ['done', 'todo', 'warn', 'blocked'];

/** Un point de contrôle complet : `{ id, labelKey, state, done, total, detail, link, group, required, weight }`. */
function makeItem(id, { state, done = 0, total = 0, detail = null, link = null }) {
  const def = ITEM_BY_ID[id];
  if (!def) throw new Error(`point de contrôle inconnu : ${id}`);
  if (!ITEM_STATES.includes(state)) throw new Error(`état inconnu : ${state}`);
  return {
    id, labelKey: `finance.progress.items.${id}`, state, done, total, detail, link,
    group: def.group, required: def.required, weight: def.required ? WEIGHT_REQUIRED : WEIGHT_OPTIONAL,
  };
}

/** Part faite d'un point (0 à 1) : done / total quand il y a un total, sinon fait ou pas. */
function itemFraction(it) {
  if (it.state === 'done') return 1;
  if (it.total > 0) return Math.max(0, Math.min(1, it.done / it.total));
  return 0;
}

/** Pourcentage pondéré (0 à 100, entier) et `ready`, à partir des points déjà construits. */
function finalizeProgress(items) {
  let w = 0, got = 0;
  for (const it of items) { w += it.weight; got += it.weight * itemFraction(it); }
  const required = items.filter((it) => it.required && !ITEM_BY_ID[it.id].final);
  const requiredDone = required.filter((it) => it.state === 'done').length;
  return {
    percent: w ? Math.round((got / w) * 100) : 0,
    ready: required.length > 0 && requiredDone === required.length,
    requiredDone,
    requiredTotal: required.length,
    weighting: { required: WEIGHT_REQUIRED, optional: WEIGHT_OPTIONAL },
  };
}

/** Comptes par groupe et par état (pour la barre et les points de la liste). */
function summarize(lines) {
  const out = { total: 0, approved: 0, stale: 0, submitted: 0, proposed: 0, default: 0, ownersMissing: 0, groups: {} };
  for (const g of ['revenue', 'cogs', 'opex']) out.groups[g] = { total: 0, approved: 0, stale: 0, submitted: 0, proposed: 0, default: 0 };
  for (const l of lines) {
    out.total++; out[l.state]++;
    const g = out.groups[l.group];
    g.total++; g[l.state]++;
    if (!l.owner) out.ownersMissing++;
  }
  return out;
}

module.exports = {
  REVENUE_INPUTS, COGS_INPUTS, TRAVEL_KEYS, DEFAULT_DIRECTORY, OWNER_MAX, MAX_KEYS, STATES, ITEM_DEFS, ITEM_STATES,
  WEIGHT_REQUIRED, WEIGHT_OPTIONAL,
  editableOpexLines, buildLines, driverValues, opexValues, applyGrowth, lineValues,
  hashValues, displayState, cleanOwner, cleanKeys, makeItem, itemFraction, finalizeProgress, summarize,
};
