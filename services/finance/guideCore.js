// ============================================================================
// Module Finance — lot H (guide des gestionnaires, pistes d'économies, règle des 40, repères) :
// calculs PURS, sans base ni HTTP. Testés à la main dans __tests__/guide.test.js.
//
// ⚠️ GARDER IDENTIQUES les fonctions rule40 / levers / compareBenchmarks à celles du navigateur
// (frontend src/pages/Finance/Guide/guideModel.ts) : le banc d'essai du frontend les compare
// sur des entrées aléatoires.
//
// Jamais de nom d'employé, de salaire ni de client ici : tout est agrégé par compte du grand
// livre ou par ligne du budget.
// ============================================================================

const THRESHOLD = 40; // règle des 40 : croissance % + marge % ≥ 40 (convention du secteur)
const TOLERANCE_PCT = 5; // « dans la moyenne » = à ±5 % (relatif) du repère
const DEFAULT_PARAMS = { minPct: 15, minAbs: 500, avgWindow: 3, topN: 10, maxLeads: 30 };

// Départements possibles pour un compte du grand livre (écran d'assignation).
const DEPARTMENTS = ['sales', 'support_ops', 'accounting', 'rnd', 'other'];

// Mesures comparables à un repère. `model` = calculable par le modèle FY2027 (navigateur),
// `actual` = calculable à partir des réels du grand livre (ici).
const METRICS = {
  rule_of_40: { unit: 'pts', model: true, actual: true },
  revenue_growth: { unit: 'pct', model: true, actual: true },
  gross_margin: { unit: 'pct', model: true, actual: true },
  ebitda_margin: { unit: 'pct', model: true, actual: true },
  sm_pct: { unit: 'pct', model: true, actual: false },
  rd_pct: { unit: 'pct', model: true, actual: false },
  ga_pct: { unit: 'pct', model: true, actual: false },
  recurring_share: { unit: 'pct', model: true, actual: false },
  churn_annual: { unit: 'pct', model: true, actual: false },
  cac_payback_months: { unit: 'months', model: true, actual: false },
  ltv_cac: { unit: 'ratio', model: true, actual: false },
  arpu_monthly: { unit: 'cad', model: true, actual: false },
  arr_per_location: { unit: 'cad_year', model: true, actual: false },
  nrr: { unit: 'pct', model: false, actual: false },
  grr: { unit: 'pct', model: false, actual: false },
};
const UNITS = ['pct', 'pts', 'months', 'ratio', 'cad', 'usd', 'cad_year', 'usd_year'];
const DIRECTIONS = ['higher_better', 'lower_better'];
const KINDS = ['public', 'reference', 'internal'];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 2) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// ---------------------------------------------------------------------------- règle des 40
const growthPct = (cur, prior) => (finite(cur) && finite(prior) && prior > 0 ? ((cur - prior) / prior) * 100 : null);
const marginPct = (profit, revenue) => (finite(profit) && finite(revenue) && revenue > 0 ? (profit / revenue) * 100 : null);

function rule40(growth, margin) {
  if (!finite(growth) || !finite(margin)) return { growth: finite(growth) ? growth : null, margin: finite(margin) ? margin : null, score: null, gap: null, passes: null };
  const score = growth + margin;
  return { growth, margin, score, gap: score - THRESHOLD, passes: score >= THRESHOLD };
}

// Leviers chiffrés. input = { revenue, priorRevenue, profit (BAIIA), opex }.
//  - onePtGrowthRevenue : +1 pt de croissance = +1 % du revenu de l'an dernier ;
//  - onePtMarginOpex    : 1 pt de marge = 1 % du revenu, soit ce montant d'OPEX en moins (revenu inchangé) ;
//  - si le score est sous 40 : revenu additionnel requis par la croissance seule, OU baisse de coûts
//    requise par la marge seule (l'autre levier restant inchangé).
function levers(input) {
  const { revenue, priorRevenue, profit, opex } = input || {};
  const growth = growthPct(revenue, priorRevenue);
  const margin = marginPct(profit, revenue);
  const r = rule40(growth, margin);
  const onePtGrowthRevenue = finite(priorRevenue) && priorRevenue > 0 ? priorRevenue * 0.01 : null;
  const onePtMarginOpex = finite(revenue) && revenue > 0 ? revenue * 0.01 : null;
  const shortfall = r.gap != null && r.gap < 0 ? -r.gap : 0;
  const extraRevenueNeeded = r.gap == null ? null : (onePtGrowthRevenue == null ? null : onePtGrowthRevenue * shortfall);
  const costCutNeeded = r.gap == null ? null : (onePtMarginOpex == null ? null : onePtMarginOpex * shortfall);
  const costCutPctOfOpex = costCutNeeded != null && finite(opex) && opex > 0 ? (costCutNeeded / opex) * 100 : null;
  return { ...r, onePtGrowthRevenue, onePtMarginOpex, shortfall, extraRevenueNeeded, costCutNeeded, costCutPctOfOpex };
}

// Points de marge gagnés par une baisse d'OPEX de `cut` $ (revenu inchangé).
const marginPtsFromCut = (cut, revenue) => (finite(cut) && finite(revenue) && revenue > 0 ? (cut / revenue) * 100 : null);

// ---------------------------------------------------------------------------- repères
// metrics : { clé: valeur } ; benchmarks : lignes de finance_benchmarks (id, metric, value, direction,
// use_for_flags…). Un repère sans valeur n'est JAMAIS comparé (« à valider »).
function compareBenchmarks(metrics, benchmarks, tolPct = TOLERANCE_PCT) {
  return (benchmarks || []).map((b) => {
    const base = { id: b.id, metric: b.metric };
    if (b.value == null || !finite(Number(b.value))) return { ...base, status: 'to_validate', flag: false, delta: null, current: null };
    const bv = Number(b.value);
    const cur = metrics ? metrics[b.metric] : null;
    if (!finite(cur)) return { ...base, status: 'no_metric', flag: false, delta: null, current: null };
    const delta = cur - bv;
    let status;
    if (Math.abs(delta) <= (Math.abs(bv) * tolPct) / 100) status = 'on_par';
    else if (b.direction === 'lower_better') status = delta < 0 ? 'better' : 'worse';
    else status = delta > 0 ? 'better' : 'worse';
    return { ...base, status, flag: status === 'worse' && b.use_for_flags !== false, delta, current: cur };
  });
}

// ---------------------------------------------------------------------------- validation des repères
const validUrl = (u) => typeof u === 'string' && u.length <= 500 && /^https?:\/\/[^\s/]+\.[^\s/]+/i.test(u);
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;

// Renvoie { error } ou { row }. Règle de la CFO : une valeur n'existe que si sa source est citable.
function validateBenchmark(b, nowYear = new Date().getFullYear()) {
  if (!b || typeof b !== 'object') return { error: 'bad_benchmark' };
  const id = b.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_.-]{2,59}$/.test(id)) return { error: 'bad_id' };
  if (!METRICS[b.metric]) return { error: 'bad_metric' };
  if (!text(b.labelEn, 120) || !text(b.labelFr, 120)) return { error: 'bad_label' };
  if (!UNITS.includes(b.unit)) return { error: 'bad_unit' };
  if (!DIRECTIONS.includes(b.direction)) return { error: 'bad_direction' };
  const kind = b.kind === undefined ? 'public' : b.kind;
  if (!KINDS.includes(kind)) return { error: 'bad_kind' };
  const useForFlags = b.useForFlags === undefined ? kind !== 'reference' : b.useForFlags;
  if (typeof useForFlags !== 'boolean') return { error: 'bad_flags' };
  const value = b.value === undefined || b.value === '' ? null : b.value;
  if (value !== null && (!finite(value) || Math.abs(value) > 1e7)) return { error: 'bad_value' };
  const org = b.sourceOrg == null || b.sourceOrg === '' ? null : b.sourceOrg;
  const url = b.sourceUrl == null || b.sourceUrl === '' ? null : b.sourceUrl;
  const year = b.sourceYear == null || b.sourceYear === '' ? null : b.sourceYear;
  const date = b.sourceDate == null || b.sourceDate === '' ? null : b.sourceDate;
  const note = b.note == null || b.note === '' ? null : b.note;
  if (org !== null && !text(org, 120)) return { error: 'bad_source_org' };
  if (url !== null && !validUrl(url)) return { error: 'bad_source_url' };
  if (year !== null && (!Number.isInteger(year) || year < 1990 || year > nowYear + 1)) return { error: 'bad_source_year' };
  if (date !== null && !(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)))) return { error: 'bad_source_date' };
  if (note !== null && (typeof note !== 'string' || note.length > 400)) return { error: 'bad_note' };
  if (value !== null) {
    // Jamais de repère non sourcé : organisme + année toujours ; URL sauf cible interne de la CFO.
    if (!org) return { error: 'source_org_required' };
    if (year === null) return { error: 'source_year_required' };
    if (kind !== 'internal' && !url) return { error: 'source_url_required' };
  }
  return {
    row: {
      id, metric: b.metric, label_en: b.labelEn.trim(), label_fr: b.labelFr.trim(), value, unit: b.unit, direction: b.direction,
      kind, use_for_flags: useForFlags, source_org: org ? org.trim() : null, source_url: url, source_year: year, source_date: date, note,
    },
  };
}

// ---------------------------------------------------------------------------- réels du grand livre
const monthNum = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const fromNum = (n) => `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
const addMonths = (m, k) => fromNum(monthNum(m) + k);
const isMonth = (m) => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const monthOf = (now) => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

// Poste d'un compte d'après le chemin de sa section dans le rapport P&L de Books
// (« Gross Profit > Operating Income », « Operating Profit > Operating Expense > … »).
// ⚠️ Forme du vrai rapport jamais vue (Books refuse nos jetons) : à vérifier à la première synchro.
function classifySection(section) {
  const s = String(section || '').toLowerCase();
  if (!s.trim()) return 'unknown';
  if (/non[\s-]*operating|other (income|expense)/.test(s)) return 'nonop';
  if (/cost of goods|cost of sales|cost of revenue|cogs/.test(s)) return 'cogs';
  if (/expense/.test(s)) return 'opex';
  if (/income|revenue|sales/.test(s)) return 'revenue';
  return 'unknown';
}

const sumOver = (get, months) => months.reduce((a, m) => a + (get(m) || 0), 0);

// rows : [{ m:'YYYY-MM', key, name, section, amount }] (comptes feuilles seulement) ;
// syncedMonths : mois pour lesquels le rapport a été lu (un compte absent d'un mois lu = 0 $) ;
// owners : { clé: { owner, department, budgetLine } } ; now : Date (mois en cours exclu : incomplet).
function analyzeActuals({ rows = [], syncedMonths = [], owners = {}, now = new Date(), params = {} } = {}) {
  const P = { ...DEFAULT_PARAMS, ...params };
  const cur = monthOf(now);
  const closed = [...new Set(syncedMonths.filter(isMonth))].filter((m) => m < cur).sort();
  const closedSet = new Set(closed);
  const out = {
    hasActuals: closed.length > 0, latestMonth: closed.length ? closed[closed.length - 1] : null, monthsAvailable: closed.length,
    params: P, metrics: null, metricsReason: null, leads: [], topAccounts: [], unassigned: [], accounts: [], budgetLines: {},
    classification: { revenue: 0, cogs: 0, opex: 0, nonop: 0, unknown: 0 }, unknownSections: [],
  };
  if (!closed.length) { out.metricsReason = 'no_actuals'; return out; }

  const accounts = new Map();
  const amt = new Map(); // key -> Map(m -> amount)
  for (const r of rows) {
    if (!closedSet.has(r.m) || !finite(Number(r.amount))) continue;
    if (!accounts.has(r.key)) accounts.set(r.key, { key: r.key, name: r.name, section: r.section || '', kind: classifySection(r.section) });
    const mm = amt.get(r.key) || new Map();
    mm.set(r.m, (mm.get(r.m) || 0) + Number(r.amount));
    amt.set(r.key, mm);
  }
  const unknownSections = new Set();
  for (const a of accounts.values()) {
    out.classification[a.kind]++;
    if (a.kind === 'unknown') unknownSections.add(a.section);
  }
  out.unknownSections = [...unknownSections].sort().slice(0, 50);
  const get = (key) => (m) => (amt.get(key) && amt.get(key).get(m)) || 0;
  const total = (kind, months) => [...accounts.values()].filter((a) => a.kind === kind).reduce((s, a) => s + sumOver(get(a.key), months), 0);

  // --- indicateurs sur 12 mois glissants (aucune extrapolation : il faut les 12 mois lus)
  const latest = out.latestMonth;
  const win = Array.from({ length: 12 }, (_, i) => addMonths(latest, i - 11));
  const prior = win.map((m) => addMonths(m, -12));
  if (win.every((m) => closedSet.has(m))) {
    const revenue = total('revenue', win), cogs = total('cogs', win), opex = total('opex', win);
    const ebitda = revenue - cogs - opex;
    const havePrior = prior.every((m) => closedSet.has(m));
    const priorRevenue = havePrior ? total('revenue', prior) : null;
    const g = havePrior ? growthPct(revenue, priorRevenue) : null;
    const mg = marginPct(ebitda, revenue);
    const r = rule40(g, mg);
    out.metrics = {
      from: win[0], to: latest, revenue: round(revenue), cogs: round(cogs), opex: round(opex), ebitda: round(ebitda), priorRevenue: round(priorRevenue),
      growthPct: round(g), ebitdaMarginPct: round(mg), grossMarginPct: round(marginPct(revenue - cogs, revenue)),
      rule40: r.score == null ? null : round(r.score), gap: r.gap == null ? null : round(r.gap),
      levers: levers({ revenue, priorRevenue, profit: ebitda, opex }),
      note: 'ebitda_is_operating_profit',
    };
    if (!havePrior) out.metricsReason = 'growth_needs_24_months';
  } else {
    out.metricsReason = 'needs_12_months';
  }

  // --- pistes sur les comptes de dépense (coûts des ventes + OPEX), comptes feuilles
  const expense = [...accounts.values()].filter((a) => a.kind === 'cogs' || a.kind === 'opex');
  const ownerOf = (key) => owners[key] || null;
  const wmonths = closed.slice(-12);
  const totalExp = expense.reduce((s, a) => s + sumOver(get(a.key), wmonths), 0);
  const leads = [];
  const prev3 = Array.from({ length: P.avgWindow }, (_, i) => addMonths(latest, -(i + 1)));
  const ly = addMonths(latest, -12);
  for (const a of expense) {
    const g = get(a.key);
    const last = g(latest);
    const o = ownerOf(a.key);
    const base = {
      accountKey: a.key, accountName: a.name, section: a.section, kind: a.kind, month: latest, amount: round(last),
      owner: o ? o.owner : null, department: o ? o.department : null, assigned: !!o,
    };
    if (prev3.every((m) => closedSet.has(m))) {
      const avg = sumOver(g, prev3) / prev3.length;
      const d = last - avg;
      const pct = avg > 0 ? (d / avg) * 100 : null;
      if (d >= P.minAbs && (pct == null || pct >= P.minPct)) leads.push({ ...base, type: 'vs_avg', baseline: round(avg), deltaAbs: round(d), deltaPct: round(pct) });
    }
    if (closedSet.has(ly)) {
      const b = g(ly);
      const d = last - b;
      const pct = b > 0 ? (d / b) * 100 : null;
      if (d >= P.minAbs && (pct == null || pct >= P.minPct)) leads.push({ ...base, type: 'vs_last_year', baseline: round(b), deltaAbs: round(d), deltaPct: round(pct) });
    }
  }
  leads.sort((x, y) => y.deltaAbs - x.deltaAbs || x.accountKey.localeCompare(y.accountKey));
  out.leads = leads.slice(0, P.maxLeads).map((l, i) => ({ id: `${l.type}:${l.accountKey}`, rank: i + 1, ...l }));

  const withTotals = expense.map((a) => {
    const o = ownerOf(a.key);
    return {
      accountKey: a.key, accountName: a.name, section: a.section, kind: a.kind, windowTotal: round(sumOver(get(a.key), wmonths)), lastAmount: round(get(a.key)(latest)),
      sharePct: totalExp > 0 ? round((sumOver(get(a.key), wmonths) / totalExp) * 100) : null,
      owner: o ? o.owner : null, department: o ? o.department : null, budgetLine: o ? o.budgetLine || null : null, assigned: !!o,
    };
  }).sort((x, y) => y.windowTotal - x.windowTotal || x.accountKey.localeCompare(y.accountKey));
  out.accounts = withTotals;
  out.topAccounts = withTotals.slice(0, P.topN).map((a) => ({ ...a, windowMonths: wmonths.length }));
  out.unassigned = withTotals.filter((a) => !a.assigned);

  // --- série mensuelle par ligne de budget (la comparaison au budget se fait dans le navigateur)
  for (const a of expense) {
    const o = ownerOf(a.key);
    if (!o || !o.budgetLine) continue;
    const bl = out.budgetLines[o.budgetLine] || {};
    for (const m of closed) bl[m] = round((bl[m] || 0) + get(a.key)(m));
    out.budgetLines[o.budgetLine] = bl;
  }
  return out;
}

module.exports = {
  THRESHOLD, TOLERANCE_PCT, DEFAULT_PARAMS, DEPARTMENTS, METRICS, UNITS, DIRECTIONS, KINDS,
  growthPct, marginPct, rule40, levers, marginPtsFromCut, compareBenchmarks, validateBenchmark,
  classifySection, analyzeActuals, addMonths, isMonth,
};
