// ============================================================================
// Module Finance — lot F : suggestions de drivers selon l'historique. Fonctions PURES (aucune
// base, aucun réseau) : le serveur (suggestions.js) lit les tables, ce fichier calcule.
//
// Principe : pour chaque driver dont Sales Hub possède un HISTORIQUE (Zoho Billing, Zentact),
// on reconstruit la série mensuelle des 24 derniers mois CLOS, puis on propose 12 valeurs
// (janvier à décembre de l'exercice) par une méthode simple et explicable :
//   - moyenne des N derniers mois (N = 3, 6 ou 12 ; 6 par défaut) ;
//   - tendance linéaire (moindres carrés) sur les 12 derniers mois ;
//   - « même mois l'an dernier » (comptes seulement, si 24 mois de données).
// La méthode par défaut dépend de la STABILITÉ de la série (coefficient de variation) et elle
// est DITE (basis.why). Jamais de valeur hors bornes, jamais de division par zéro silencieuse.
//
// ⚠️ Les formules de comptage ne sont PAS recopiées : elles viennent de kpiCore.js
// (computeBillingFacts : activations, revendeurs en mots entiers, changements de propriétaire).
// ============================================================================

const K = require('./kpiCore');

// ---------------------------------------------------------------------------- catalogue
// Types : count = nombre de rooftops/clients (entier ≥ 0) ; growth = croissance mensuelle en % ;
// share = pourcentage 0..100 ; money = montant en $.
const BOUNDS = { count: [0, 5000], growth: [-50, 50], share: [0, 100], money: [0, 1e7] };
const MAX_ABS = 1e10; // même plafond que validateSection('drivers') de routes.js

// [type, description anglaise courte (sert au prompt de l'IA)]
const CATALOG = {
  intAdds: ['count', 'Rooftops added per month by the internal sales team (Canada), excluding resellers and ownership changes'],
  resAdds: ['count', 'Rooftops added per month through resellers (Canada)'],
  xpAdds: ['count', 'Rooftops added per month by the Xperio brand'],
  canChurn: ['count', 'Canadian rooftops lost per month (ownership changes excluded)'],
  usaChurn: ['count', 'US rooftops lost per month (ownership changes excluded)'],
  xpChurn: ['count', 'Xperio rooftops lost per month (ownership changes excluded)'],
  canArpuG: ['growth', 'Monthly growth of the Canadian average revenue per rooftop, in percent'],
  usaArpuG: ['growth', 'Monthly growth of the US average revenue per rooftop, in percent'],
  xpArpuG: ['growth', 'Monthly growth of the Xperio average revenue per rooftop, in percent'],
  residG: ['growth', 'Monthly growth of partner residuals, in percent'],
  contractsG: ['growth', 'Monthly growth of Xperio service contracts, in percent'],
  adyenTarget: ['count', 'Total payment-processing (Adyen) rooftop adds per month'],
  adyenResAdds: ['count', 'Payment-processing rooftop adds per month through resellers'],
  adyenXpAdds: ['count', 'Payment-processing rooftop adds per month from Xperio'],
  adyenChurn: ['count', 'Payment-processing rooftops lost per month'],
  adyenArpuG: ['growth', 'Monthly growth of the payment-processing revenue per rooftop, in percent'],
  convPct: ['share', 'Share (percent) of internal POS adds that also adopt payment processing'],
  partnerPayG: ['growth', 'Monthly growth of partner payment revenue, in percent'],
  xpPartnerG: ['growth', 'Monthly growth of Xperio partner payment revenue, in percent'],
  newClientPct: ['share', 'Share (percent) of internal adds that are brand-new POS clients'],
  hwPerNew: ['money', 'Hardware revenue per new rooftop, in dollars'],
  existClients: ['count', 'Existing clients buying hardware per month'],
  hwPerExist: ['money', 'Hardware revenue per existing client, in dollars'],
  xpHw: ['money', 'Xperio hardware revenue per month, in dollars'],
  cpHw: ['money', 'Control Plus hardware revenue per month, in dollars'],
  installPrice: ['money', 'Installation price per new rooftop, in dollars'],
  discount: ['money', 'Installation discount per new rooftop, in dollars'],
  onsite: ['money', 'On-site service revenue per month, in dollars'],
  xpService: ['money', 'Xperio service revenue per month, in dollars'],
  licG: ['growth', 'Monthly growth of licence and other revenue, in percent'],
  supportSw: ['money', 'Support software, phone and other cost per month, in dollars'],
  merchantFees: ['money', 'Merchant fees per month, in dollars'],
  platformFees: ['money', 'Payments platform fees per month, in dollars'],
  hostingG: ['growth', 'Monthly growth of hosting and tool costs, in percent'],
  resellerSaasG: ['growth', 'Monthly growth of reseller SaaS revenue, in percent'],
  revShare: ['share', 'Revenue share paid to resellers, in percent'],
  clusterHwPct: ['share', 'Cluster hardware cost as a percent of hardware revenue'],
  xperioHwPct: ['share', 'Xperio hardware cost as a percent of hardware revenue'],
  halukPct: ['share', 'Share (percent) of install jobs given to the external installer'],
  onsites: ['count', 'On-site jobs per month'],
  jobCost: ['money', 'Cost per external job, in dollars'],
  buffer: ['money', 'Service contractor buffer per month, in dollars'],
  // SH-49 : l'automobile a ses propres lignes (nnAuto / exAuto) ; cette ligne ne la couvre plus.
  travel: ['money', 'Service travel and meals cost per month, in dollars (automobile has its own lines)'],
  svcSw: ['money', 'Service software, phone, hardware and other cost per month, in dollars'],
  licPct: ['share', 'Licence cost as a percent of licence revenue'],
  // SH-49 : COGS de service en deux blocs (Net New Delivery / Existing Service).
  implNnPct: ['share', 'Share (percent) of Implementation payroll charged to Net New Delivery; the rest goes to Existing Service'],
  svcSwNnPct: ['share', 'Share (percent) of service software costs charged to Net New Delivery; the rest goes to Existing Service'],
  bufferNnPct: ['share', 'Share (percent) of the service contractor buffer kept for Net New Delivery; the rest goes to Existing Service'],
  nnImplSw: ['money', 'Net New implementation software cost per month, in dollars'],
  exImplSw: ['money', 'Existing implementation software cost per month, in dollars'],
  nnAuto: ['money', 'Net New Delivery automobile cost per month, in dollars'],
  exAuto: ['money', 'Existing Service automobile cost per month, in dollars'],
};
// Inputs « morts » : la paie les remplace dans le modèle (model.ts) — ni suggestion ni brouillon.
const DEAD_DRIVERS = ['supportWages', 'supportContr', 'nnWages', 'exWages'];
const DRIVER_KEYS = Object.keys(CATALOG);

const typeOf = (key) => (CATALOG[key] ? CATALOG[key][0] : null);
const describe = (key) => (CATALOG[key] ? CATALOG[key][1] : '');
const boundsOf = (key) => { const t = typeOf(key); return t ? BOUNDS[t] : null; };

const round2 = (v) => Math.round(v * 100) / 100;
function roundFor(key, v) {
  return typeOf(key) === 'count' ? Math.round(v) : round2(v);
}
const clampFor = (key, v) => { const [lo, hi] = boundsOf(key); return Math.min(hi, Math.max(lo, v)); };
// Valeur finale d'une suggestion : arrondie PUIS bornée (un compte reste un entier ≥ 0).
const finalize = (key, v) => clampFor(key, roundFor(key, v));

// Validation d'un jeu de 12 valeurs (brouillon de l'IA, application) : mêmes exigences que
// validateSection('drivers') de routes.js (12 nombres finis < 1e10) + les bornes du catalogue.
// Renvoie { values } (comptes arrondis) ou { error }.
function normalizeValues(key, arr) {
  const b = boundsOf(key);
  if (!b) return { error: 'unknown_driver' };
  if (!Array.isArray(arr) || arr.length !== 12) return { error: 'bad_length' };
  const out = [];
  for (const v of arr) {
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) >= MAX_ABS) return { error: 'not_finite' };
    const r = roundFor(key, v);
    if (r < b[0] || r > b[1]) return { error: 'out_of_bounds' };
    out.push(r);
  }
  return { values: out };
}

// ---------------------------------------------------------------------------- statistiques
const finiteOnly = (a) => a.filter((v) => v != null && Number.isFinite(v));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const stdev = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) * (v - m)))); };
// Coefficient de variation ; moyenne nulle : 0 si la série est plate, sinon Infinity (jamais NaN).
function cvOf(a) {
  if (!a.length) return Infinity;
  const m = mean(a), s = stdev(a);
  if (Math.abs(m) < 1e-12) return s < 1e-12 ? 0 : Infinity;
  return s / Math.abs(m);
}
function pearson(x, y) {
  if (x.length !== y.length || x.length < 3) return null;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  if (sxx < 1e-12 || syy < 1e-12) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// Moyenne des N derniers mois. Il faut au moins min(N, 3) points : sinon pas de suggestion.
function avgMethod(hist, N) {
  const win = hist.slice(-N);
  const s = finiteOnly(win);
  if (s.length < Math.min(N, 3)) return null;
  return { windowMonths: N, sample: s, at: () => mean(s) };
}
// Régression linéaire sur les 12 derniers mois (au moins 6 points). `at(k)` = valeur projetée k
// mois après le dernier mois de l'historique.
function trendMethod(hist) {
  const win = hist.slice(-12);
  const pts = [];
  win.forEach((v, i) => { if (v != null && Number.isFinite(v)) pts.push([i, v]); });
  if (pts.length < 6) return null;
  const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  const slope = sxx ? sxy / sxx : 0;
  const icpt = my - slope * mx;
  const r2 = syy < 1e-12 ? 0 : (sxy * sxy) / (sxx * syy);
  return { windowMonths: win.length, sample: pts.map((p) => p[1]), slope, r2, mean: my, at: (k) => icpt + slope * (win.length - 1 + k) };
}
// Résidus d'une série après retrait de sa droite des moindres carrés : une simple pente (rampe
// régulière) n'est pas une saisonnalité.
function detrend(a) {
  const n = a.length;
  const mx = (n - 1) / 2, my = mean(a);
  let sxy = 0, sxx = 0;
  a.forEach((y, i) => { sxy += (i - mx) * (y - my); sxx += (i - mx) ** 2; });
  const slope = sxx ? sxy / sxx : 0;
  return a.map((y, i) => y - (my + slope * (i - mx)));
}
// « Même mois l'an dernier » : 24 mois de données COMPLÈTES, valeur la plus récente du même mois
// civil. `corr` = corrélation, une fois la pente retirée, entre les 12 derniers mois et les 12
// précédents (la saisonnalité se répète d'une année à l'autre).
function seasonalMethod(hist, months) {
  if (hist.length < 24 || months.length !== hist.length) return null;
  const last24 = hist.slice(-24);
  if (last24.some((v) => v == null || !Number.isFinite(v))) return null;
  const cur = last24.slice(12), prev = last24.slice(0, 12);
  const curMonths = months.slice(-12);
  return {
    windowMonths: 12, sample: cur, corr: pearson(detrend(cur), detrend(prev)),
    at: (targetMonth) => {
      const j = curMonths.findIndex((m) => m.slice(5) === targetMonth.slice(5));
      return j < 0 ? null : cur[j];
    },
  };
}

// ---------------------------------------------------------------------------- méthode par défaut
// 1. moins de 6 mois de données → moyenne (confiance basse) ;
// 2. comptes avec 24 mois et saisonnalité nette (corrélation ≥ 0,5 entre les deux années) → même mois l'an dernier ;
// 3. tendance nette (R² ≥ 0,5 et dérive annuelle ≥ 15 % de la moyenne) → tendance ;
// 4. sinon → moyenne des N derniers mois (N au choix, 6 par défaut).
function pickMethod(hist, months, key, windowN) {
  const last12 = finiteOnly(hist.slice(-12));
  const cv = cvOf(last12);
  if (last12.length < 6) return { method: 'avg', why: 'short_history', cv, confidence: 'low' };
  const conf = cv < 0.25 && last12.length >= 12 ? 'high' : cv < 0.6 ? 'medium' : 'low';
  const seas = typeOf(key) === 'count' ? seasonalMethod(hist, months) : null;
  if (seas && seas.corr != null && seas.corr >= 0.5) return { method: 'seasonal', why: 'seasonal', cv, corr: seas.corr, confidence: conf };
  const tr = trendMethod(hist);
  if (tr && tr.r2 >= 0.5 && Math.abs(mean(tr.sample)) > 1e-12 && Math.abs(tr.slope * 12) / Math.abs(tr.mean) >= 0.15) {
    return { method: 'trend', why: 'trend', cv, r2: tr.r2, confidence: conf };
  }
  return { method: 'avg', why: cv < 0.25 ? 'stable' : 'variable', cv, confidence: conf };
}

// ---------------------------------------------------------------------------- une suggestion
// hist : série mensuelle (nombres ou null) alignée sur `months` ('YYYY-MM', mois clos, du plus
// ancien au plus récent) ; targets : les 12 mois de l'exercice ; opts.window : 3 | 6 | 12 ;
// opts.method : 'avg' | 'trend' | 'seasonal' pour forcer. Renvoie null si aucune méthode ne tient.
function buildSuggestion(key, hist, months, targets, opts = {}) {
  const type = typeOf(key);
  if (!type) return null;
  const windowN = [3, 6, 12].includes(opts.window) ? opts.window : 6;
  const last = months[months.length - 1];
  const ks = targets.map((t) => K.monthDiff(last, t));
  const compute = (m, N) => {
    if (m === 'avg') {
      const a = avgMethod(hist, N);
      if (!a) return null;
      const v = finalize(key, a.at());
      return { method: 'avg', windowMonths: a.windowMonths, sample: a.sample.map(round2), suggested: targets.map(() => v) };
    }
    if (m === 'trend') {
      const t = trendMethod(hist);
      if (!t) return null;
      return { method: 'trend', windowMonths: t.windowMonths, sample: t.sample.map(round2), suggested: ks.map((k) => finalize(key, t.at(k))) };
    }
    if (m === 'seasonal') {
      if (type !== 'count') return null;
      const s = seasonalMethod(hist, months);
      if (!s) return null;
      const vals = targets.map((t) => s.at(t));
      if (vals.some((v) => v == null)) return null;
      return { method: 'seasonal', windowMonths: 12, sample: s.sample.map(round2), suggested: vals.map((v) => finalize(key, v)) };
    }
    return null;
  };

  const pick = pickMethod(hist, months, key, windowN);
  let method = pick.method;
  let forced = false;
  if (opts.method && ['avg', 'trend', 'seasonal'].includes(opts.method)) { method = opts.method; forced = true; }
  let main = compute(method, windowN);
  if (!main && forced) { main = compute(pick.method, windowN); forced = false; }
  if (!main) main = compute('avg', windowN) || compute('avg', 12) || compute('avg', 3);
  if (!main) return null;

  const alternatives = [];
  for (const N of [3, 6, 12]) { const a = compute('avg', N); if (a) alternatives.push({ method: 'avg', windowMonths: N, suggested: a.suggested }); }
  for (const m of ['trend', 'seasonal']) { const a = compute(m, 12); if (a) alternatives.push({ method: m, windowMonths: a.windowMonths, suggested: a.suggested }); }

  const unit = type === 'count' ? 'count' : type === 'growth' ? 'pct_per_month' : type === 'share' ? 'pct' : 'money';
  let confidence = pick.confidence;
  if (opts.capConfidence === 'low') confidence = 'low';
  else if (opts.capConfidence === 'medium' && confidence === 'high') confidence = 'medium';
  return {
    key,
    suggested: main.suggested,
    basis: {
      method: main.method, windowMonths: main.windowMonths, sample: main.sample, unit,
      why: forced ? 'chosen' : pick.why,
      cv: Number.isFinite(pick.cv) ? round2(pick.cv) : null,
      note: opts.note || '',
    },
    history: { months: months.slice(), values: hist.map((v) => (v == null || !Number.isFinite(v) ? null : round2(v))) },
    confidence,
    alternatives,
  };
}

// ---------------------------------------------------------------------------- historique Billing
const orgSet = (a) => new Set((a || []).map(String));

// Faits Billing d'un ensemble d'organisations, par mois : on RÉUTILISE computeBillingFacts
// (kpiCore) en présentant l'ensemble comme « Canada » — activations, revendeurs, changements de
// propriétaire, résiliations — sans recopier aucune règle.
function orgFacts(rows, orgs, months, ctx) {
  const set = orgSet(orgs);
  const sub = rows.filter((r) => set.has(String(r.org_id)));
  const res = K.computeBillingFacts(sub, months, {
    canadaOrgs: [...set], usaOrgs: [], cooReasons: ctx.cooReasons, aliases: ctx.aliases, mrrStatuses: ctx.mrrStatuses,
  });
  return { facts: res.facts, detail: res.detail, rows: sub };
}

// Avant le premier mois d'activité de l'organisation, la série est INCONNUE (null), pas zéro.
function firstMonthOf(rows) {
  let f = null;
  for (const r of rows) { const m = r.activated_at ? r.activated_at.slice(0, 7) : null; if (m && (!f || m < f)) f = m; }
  return f;
}
const maskBefore = (series, months, first) => series.map((v, i) => (first == null || months[i] < first ? null : v));

// ARPU de fin de mois reconstruit : MRR ÷ abonnements actifs ce jour-là (mêmes règles que la
// reconstitution de la MRR É.-U. de kpiCore : activé au plus tard, pas encore résilié, ou
// aucune résiliation et statut générateur de MRR). Montant ACTUEL des abonnements (Zoho ne garde
// pas l'historique des prix) : la croissance mesurée est donc celle du MIX, pas des hausses de prix.
function arpuByMonth(rows, months, mrrStatuses) {
  const out = [];
  for (const m of months) {
    const end = K.monthEnd(m);
    let mrr = 0, n = 0;
    for (const r of rows) {
      if (!r.activated_at || r.activated_at > end) continue;
      if (r.cancelled_at) { if (r.cancelled_at <= end) continue; } else if (!mrrStatuses.has(r.status)) continue;
      mrr += Number(r.monthly_amount) || 0; n++;
    }
    out.push(n ? mrr / n : null);
  }
  return out;
}
// Croissance mensuelle en % entre deux fins de mois consécutives. Le modèle applique la
// croissance AVANT usage (janvier = décembre × (1 + g)) : g du mois m = ARPU(m) / ARPU(m−1) − 1.
function arpuGrowth(rows, months, mrrStatuses) {
  const a = arpuByMonth(rows, [K.addMonths(months[0], -1), ...months], mrrStatuses);
  return months.map((_, i) => (a[i] != null && a[i + 1] != null && a[i] > 0 ? (a[i + 1] / a[i] - 1) * 100 : null));
}

function billingHistory(rows, months, ctx) {
  const out = {};
  const can = orgFacts(rows, ctx.canadaOrgs, months, ctx);
  const usa = orgFacts(rows, ctx.usaOrgs, months, ctx);
  const xp = orgFacts(rows, ctx.xpOrgs, months, ctx);
  const nz = (v) => Math.max(0, v);
  const fc = (o) => ({ first: firstMonthOf(o.rows) });

  const cf = fc(can), uf = fc(usa), xf = fc(xp);
  out.intAdds = maskBefore(months.map((m) => nz(can.facts[m].activations - can.facts[m].resellerActivations - can.facts[m].cooCancellations)), months, cf.first);
  out.resAdds = maskBefore(months.map((m) => can.facts[m].resellerActivations), months, cf.first);
  out.canChurn = maskBefore(months.map((m) => nz(can.facts[m].cancellations - can.facts[m].cooCancellations)), months, cf.first);
  out.usaChurn = maskBefore(months.map((m) => nz(usa.facts[m].cancellations - usa.facts[m].cooCancellations)), months, uf.first);
  out.xpAdds = maskBefore(months.map((m) => nz(xp.facts[m].activations - xp.facts[m].cooCancellations)), months, xf.first);
  out.xpChurn = maskBefore(months.map((m) => nz(xp.facts[m].cancellations - xp.facts[m].cooCancellations)), months, xf.first);

  // Part de nouveaux clients parmi les ajouts internes : abonnements activés le jour de la toute
  // première activation de leur client (identifiant Zoho, sinon nom normalisé).
  const custKey = (r) => (r.customer_id ? `id:${r.customer_id}` : `n:${K.words(r.customer_name).join(' ')}`);
  const earliest = new Map();
  for (const r of can.rows) {
    if (!r.activated_at) continue;
    const k = custKey(r);
    if (!earliest.has(k) || r.activated_at < earliest.get(k)) earliest.set(k, r.activated_at);
  }
  const byKey = new Map(can.rows.map((r) => [`${r.org_id}|${r.subscription_number}`, r]));
  out.newClientPct = maskBefore(months.map((m, i) => {
    const intAdds = out.intAdds[i];
    if (!intAdds) return null;
    let first = 0;
    for (const a of can.detail[m].activations) {
      if (a.reseller || a.cooOf) continue;
      const r = byKey.get(`${a.org}|${a.sub}`);
      if (r && earliest.get(custKey(r)) === r.activated_at) first++;
    }
    return Math.min(100, (100 * first) / intAdds);
  }), months, cf.first);

  out.canArpuG = maskBefore(arpuGrowth(can.rows, months, ctx.mrrStatuses), months, cf.first);
  out.usaArpuG = maskBefore(arpuGrowth(usa.rows, months, ctx.mrrStatuses), months, uf.first);
  out.xpArpuG = maskBefore(arpuGrowth(xp.rows, months, ctx.mrrStatuses), months, xf.first);
  out._present = { can: can.rows.length > 0, usa: usa.rows.length > 0, xp: xp.rows.length > 0 };
  return out;
}

// ---------------------------------------------------------------------------- historique Zentact
// merchants : [{ activated_at: 'YYYY-MM-DD' | null }] ; revenue : [{ year, month, currency,
// total_volume_cents, payments_count, transaction_profit_cents, other_revenue_cents }].
function zentactHistory(merchants, revenue, months) {
  const out = { adyenTarget: null, adyenArpuG: null, _present: { merchants: false, revenue: false } };
  const acts = (merchants || []).filter((m) => m.activated_at);
  if (acts.length) {
    const by = {};
    for (const m of acts) { const k = m.activated_at.slice(0, 7); by[k] = (by[k] || 0) + 1; }
    const first = Object.keys(by).sort()[0];
    out.adyenTarget = months.map((m) => (m < first ? null : by[m] || 0));
    out._present.merchants = true;
  }
  const rev = revenue || [];
  if (rev.length) {
    // Une seule devise (la plus fréquente) : additionner des CAD et des USD fausserait le revenu par marchand.
    const cnt = {};
    for (const r of rev) cnt[r.currency || ''] = (cnt[r.currency || ''] || 0) + 1;
    const cur = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
    const agg = {};
    for (const r of rev) {
      if ((r.currency || '') !== cur) continue;
      if (!(Number(r.total_volume_cents) > 0 || Number(r.payments_count) > 0)) continue;
      const k = `${r.year}-${String(r.month).padStart(2, '0')}`;
      const a = agg[k] || (agg[k] = { sum: 0, n: 0 });
      a.sum += (Number(r.transaction_profit_cents) || 0) + (Number(r.other_revenue_cents) || 0);
      a.n++;
    }
    const arpu = (m) => (agg[m] && agg[m].n ? agg[m].sum / agg[m].n : null);
    out.adyenArpuG = months.map((m) => {
      const a = arpu(K.addMonths(m, -1)), b = arpu(m);
      return a != null && b != null && a > 0 ? (b / a - 1) * 100 : null;
    });
    out._present.revenue = Object.keys(agg).length > 0;
  }
  return out;
}

// ---------------------------------------------------------------------------- indisponibles
// Code (traduit par le navigateur) + phrase anglaise de secours.
const UNAVAILABLE_DETAIL = {
  billing_not_synced: 'Zoho Billing history has not been synchronized yet.',
  no_history: 'No Zoho Billing subscriptions found for this organization.',
  insufficient_history: 'Not enough months of usable history (at least 3 are needed).',
  zentact_empty: 'No Zentact data is available yet.',
  no_closure_date: 'Zentact does not record when a merchant closed, so payment churn cannot be rebuilt.',
  no_reliable_join: 'There is no reliable link between a POS subscription and its payment merchant (links are partial).',
  no_source: 'No data source exists in Sales Hub for this driver.',
  not_defined: 'The reseller or Xperio split of payment adds is not defined in the source data.',
  ledger_required: 'General-ledger actuals are required (Zoho Books must be reconnected).',
};
const FIXED_UNAVAILABLE = {
  adyenChurn: 'no_closure_date', convPct: 'no_reliable_join',
  partnerPayG: 'no_source', xpPartnerG: 'no_source', contractsG: 'no_source', residG: 'no_source',
  adyenResAdds: 'not_defined', adyenXpAdds: 'not_defined',
};
const LEDGER_KEYS = new Set(['hwPerNew', 'existClients', 'hwPerExist', 'xpHw', 'cpHw', 'installPrice', 'discount', 'onsite', 'xpService', 'licG',
  'supportSw', 'merchantFees', 'platformFees', 'hostingG', 'resellerSaasG', 'revShare', 'clusterHwPct', 'xperioHwPct', 'halukPct', 'onsites',
  'jobCost', 'buffer', 'travel', 'svcSw', 'licPct',
  'implNnPct', 'svcSwNnPct', 'bufferNnPct', 'nnImplSw', 'exImplSw', 'nnAuto', 'exAuto']);
const BILLING_ORG = { intAdds: 'can', resAdds: 'can', canChurn: 'can', newClientPct: 'can', canArpuG: 'can', usaChurn: 'usa', usaArpuG: 'usa', xpAdds: 'xp', xpChurn: 'xp', xpArpuG: 'xp' };
const ARPU_KEYS = new Set(['canArpuG', 'usaArpuG', 'xpArpuG', 'adyenArpuG']);

// ---------------------------------------------------------------------------- tout assembler
// input : { months (24 mois clos), targets (12), billingRows (null = table absente), zentact:
// { merchants, revenue } (null = tables absentes), ctx (billing), keys (drivers connus du budget),
// window, method, current: { key: number[12] } }.
function suggestAll(input) {
  const { months, targets, keys } = input;
  const known = new Set(keys);
  const hist = {};
  let billingMissing = true;
  let present = { can: false, usa: false, xp: false };
  if (input.billingRows && input.billingRows.length) {
    billingMissing = false;
    const h = billingHistory(input.billingRows, months, input.ctx);
    present = h._present;
    for (const k of Object.keys(h)) if (k !== '_present') hist[k] = h[k];
  }
  const z = zentactHistory(input.zentact && input.zentact.merchants, input.zentact && input.zentact.revenue, months);
  if (z.adyenTarget) hist.adyenTarget = z.adyenTarget;
  if (z.adyenArpuG) hist.adyenArpuG = z.adyenArpuG;

  const suggestions = [];
  const unavailable = [];
  const miss = (key, reason) => unavailable.push({ key, reason, detail: UNAVAILABLE_DETAIL[reason] || '' });
  for (const key of DRIVER_KEYS) {
    if (!known.has(key)) continue;
    if (FIXED_UNAVAILABLE[key]) { miss(key, FIXED_UNAVAILABLE[key]); continue; }
    if (LEDGER_KEYS.has(key)) { miss(key, 'ledger_required'); continue; }
    const org = BILLING_ORG[key];
    if (org) {
      if (billingMissing) { miss(key, 'billing_not_synced'); continue; }
      if (!present[org]) { miss(key, 'no_history'); continue; }
    }
    if ((key === 'adyenTarget' || key === 'adyenArpuG') && !hist[key]) { miss(key, 'zentact_empty'); continue; }
    const s = buildSuggestion(key, hist[key] || [], months, targets, {
      window: input.window, method: input.method,
      // Les ARPU reconstruits ignorent les hausses de prix (montant actuel) ; Zentact ne date que de 2025 : prudence.
      capConfidence: ARPU_KEYS.has(key) ? 'low' : (key === 'adyenTarget' ? 'medium' : undefined),
      note: key === 'adyenArpuG' ? 'revenue per merchant with processing volume, dominant currency only'
        : ARPU_KEYS.has(key) ? 'rebuilt from current subscription prices: measures mix, not price increases'
          : key === 'adyenTarget' ? 'merchants activated per month (all statuses)' : '',
    });
    if (!s) { miss(key, 'insufficient_history'); continue; }
    const cur = input.current && input.current[key];
    suggestions.push({ ...s, current: Array.isArray(cur) ? cur : Array(12).fill(0) });
  }
  return { suggestions, unavailable };
}

module.exports = {
  CATALOG, DEAD_DRIVERS, DRIVER_KEYS, BOUNDS, MAX_ABS, typeOf, describe, boundsOf, normalizeValues, finalize,
  mean, stdev, cvOf, pearson, avgMethod, trendMethod, seasonalMethod, pickMethod, buildSuggestion,
  orgFacts, arpuByMonth, arpuGrowth, billingHistory, zentactHistory, suggestAll, UNAVAILABLE_DETAIL,
};
