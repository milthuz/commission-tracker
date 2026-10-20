// ============================================================================
// Module Finance — onglet KPI (lot B) : fonctions PURES, sans base ni réseau.
//
// Ce que le serveur fait ici, c'est de l'ASSEMBLAGE de données : à partir de la copie locale des
// abonnements Zoho Billing (finance_billing_subs), compter par mois les activations, les
// résiliations, les changements de propriétaire, etc. Les FORMULES des KPI (ARPU, coût
// d'acquisition, parc cumulé, écarts, colonne 12 mois) vivent dans le navigateur :
// frontend src/pages/Finance/Kpi/kpiModel.ts.
//
// Définitions retenues (document Word « KPI Dashboard » de la CFO, et leurs écarts —
// design/finance/ecarts/kpi.md) :
//   - un mois = 'YYYY-MM', dates de Zoho prises TELLES QUELLES (fuseau de l'organisation) ;
//   - activation = `activated_at` de l'abonnement (repli : start_date, puis
//     current_term_starts_at — marqué) ;
//   - résiliation = `cancelled_at` d'un abonnement qui n'est plus actif aujourd'hui ;
//   - changement de propriétaire (CoO) = résiliation dont le motif, NORMALISÉ (casse, accents,
//     tirets, espaces), est EXACTEMENT un des motifs configurés — jamais une sous-chaîne ;
//   - revendeur = nom du client qui contient un alias en MOTS ENTIERS (jamais une sous-chaîne :
//     « SC » du document Word attraperait « SCOTTS », « Disco », « Escale »…).
// ============================================================================

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const isMonth = (m) => typeof m === 'string' && MONTH_RE.test(m) && +m.slice(0, 4) >= 2015 && +m.slice(0, 4) <= 2040;

function addMonths(m, k) {
  const y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + k;
  const yy = y + Math.floor(mo / 12), mm = ((mo % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}
const monthDiff = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
function monthRange(from, to) {
  const out = [];
  for (let m = from; monthDiff(m, to) >= 0 && out.length < 240; m = addMonths(m, 1)) out.push(m);
  return out;
}
// Dernier jour du mois, 'YYYY-MM-DD'.
function monthEnd(m) {
  const y = +m.slice(0, 4), mo = +m.slice(5, 7);
  const d = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${m}-${String(d).padStart(2, '0')}`;
}
function addDays(ymd, k) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
}
// Date du jour à Montréal (les tâches de nuit et le « dernier mois complet » suivent l'heure de
// l'entreprise, pas celle du serveur).
function torontoToday(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
function torontoHour(now = new Date()) {
  return +new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', hourCycle: 'h23' }).format(now);
}
const lastCompleteMonth = (now = new Date()) => addMonths(torontoToday(now).slice(0, 7), -1);

// Date Zoho → 'YYYY-MM-DD' sans glissement de fuseau : une chaîne garde ses 10 premiers
// caractères (« 2026-09-30 » ou « 2026-09-30T23:10:00-0400 ») ; un nombre est une époque en
// secondes (certains champs, certaines organisations).
function zohoDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d+$/.test(s)) { const d = new Date(parseInt(s, 10) * (s.length > 11 ? 1 : 1000)); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Copie de server.js (même méthode que les tuiles MRR du tableau de bord) : montant MENSUEL.
function subMonthlyAmountLocal(amount, interval, intervalUnit) {
  const a = Number(amount) || 0;
  const iv = Math.max(1, parseInt(interval, 10) || 1);
  const unit = String(intervalUnit || 'months').toLowerCase();
  if (unit.startsWith('year')) return a / (iv * 12);
  if (unit.startsWith('week')) return (a / iv) * (52 / 12);
  if (unit.startsWith('day')) return (a / iv) * (365 / 12);
  return a / iv;
}

const DEFAULT_MRR_STATUSES = new Set(['live', 'non_renewing', 'dunning', 'unpaid']);
const DEFAULT_ACTIVE_STATUSES = new Set(['live', 'non_renewing', 'dunning', 'unpaid', 'paused']);
// Jamais activés : ni activation ni résiliation ne comptent.
const NEVER_ACTIVE = new Set(['trial', 'future', 'creation_failed', 'trial_expired']);

// Élément de la liste Zoho Billing → ligne de finance_billing_subs.
function normalizeSub(s, orgId, monthlyFn = subMonthlyAmountLocal, activeStatuses = DEFAULT_ACTIVE_STATUSES) {
  const num = String(s.subscription_number || '').trim();
  if (!num) return null;
  const status = String(s.status || '').toLowerCase();
  let activatedAt = null, activatedSrc = null;
  if (!NEVER_ACTIVE.has(status)) {
    for (const [f, src] of [['activated_at', 'activated_at'], ['start_date', 'start_date'], ['current_term_starts_at', 'term_start']]) {
      const d = zohoDate(s[f]);
      if (d) { activatedAt = d; activatedSrc = src; break; }
    }
  }
  // Un abonnement réactivé garde parfois sa vieille date de résiliation : il n'est pas résilié.
  const cancelledAt = activeStatuses.has(status) || NEVER_ACTIVE.has(status) ? null : zohoDate(s.cancelled_at);
  const monthly = monthlyFn(s.sub_total != null ? s.sub_total : s.amount, s.interval, s.interval_unit);
  return {
    org_id: String(orgId),
    subscription_number: num,
    subscription_id: s.subscription_id ? String(s.subscription_id) : null,
    customer_id: s.customer_id ? String(s.customer_id) : null,
    customer_name: String(s.customer_name || '').trim().slice(0, 500),
    plan_code: String(s.plan_code || (s.plan && s.plan.plan_code) || '').slice(0, 200),
    plan_name: String(s.plan_name || '').slice(0, 300),
    status,
    activated_at: activatedAt,
    activated_src: activatedSrc,
    cancelled_at: cancelledAt,
    cancel_reason: (s.cf_reason_for_cancel_formatted || s.cf_reason_for_cancel || null) ? String(s.cf_reason_for_cancel_formatted || s.cf_reason_for_cancel).slice(0, 300) : null,
    monthly_amount: Math.round((Number.isFinite(monthly) ? monthly : 0) * 10000) / 10000,
    currency: String(s.currency_code || '').toUpperCase().slice(0, 8) || null,
    raw_updated_at: s.updated_time ? String(s.updated_time).slice(0, 40) : null,
  };
}

// ---------------------------------------------------------------------------- textes
const deaccent = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '');
// Motif de résiliation : casse, accents, toutes les sortes de tirets, espaces autour des tirets
// et espaces multiples. « Change of Ownership – new sub created », « change of ownership-new sub
// created » et « CHANGE OF OWNERSHIP —  NEW SUB CREATED » sont le même motif ; « Change of
// ownership » tout court ne l'est PAS (égalité exacte après normalisation).
function normReason(v) {
  return deaccent(v).toLowerCase()
    .replace(/[‐-―−﹘﹣－_-]+/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}
function cooMatcher(reasons) {
  const set = new Set((reasons || []).map(normReason).filter(Boolean));
  return (reason) => !!reason && set.has(normReason(reason));
}

// Mots d'un nom (même découpage que server.js, rapport SAAS increase) : accents retirés,
// minuscules, tout ce qui n'est ni lettre ni chiffre sépare.
const words = (v) => deaccent(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
// Pluriel retiré sur les mots longs (« Solutions » = « Solution »), des deux côtés.
const stem = (w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
const GENERIC = new Set(['solution', 'technologie', 'technology', 'systeme', 'system', 'service', 'groupe', 'group',
  'inc', 'ltd', 'ltee', 'enr', 'corp', 'company', 'pos', 'the']);

// Alias des revendeurs : (1) table `resellers` — du NOM, seulement les mots distinctifs (≥ 4
// lettres, non génériques), comme server.js ; des alias SAISIS À LA MAIN, la phrase entière
// (2 caractères au moins : « SC » est la convention de Solutions Crisp) ; (2) les alias propres à
// l'onglet KPI (réglage de la CFO, liste du document Word par défaut).
// Chaque alias est une SUITE de mots entiers ; un nom correspond s'il contient cette suite.
function buildResellerAliases(resellerRows, extraAliases) {
  const out = [];
  const seen = new Set();
  const add = (label, ws) => {
    const w = ws.map(stem);
    if (!w.length || (w.length === 1 && w[0].length < 2)) return;
    const k = w.join(' ');
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ label, words: w });
  };
  for (const r of resellerRows || []) {
    if (r.active === false) continue;
    for (const w of words(r.name).map(stem).filter((x) => x.length >= 4 && !GENERIC.has(x))) add(r.name, [w]);
    for (const al of Array.isArray(r.name_aliases) ? r.name_aliases : []) add(r.name, words(al));
  }
  for (const al of extraAliases || []) add(String(al), words(al));
  return out;
}
function resellerOf(name, aliases) {
  const w = words(name).map(stem);
  if (!w.length) return null;
  for (const a of aliases) {
    const n = a.words.length;
    for (let i = 0; i + n <= w.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) if (w[i + j] !== a.words[j]) { ok = false; break; }
      if (ok) return a.label;
    }
  }
  return null;
}
// Clé de rapprochement d'un client (CoO) : identifiant Zoho, sinon nom normalisé.
const customerKey = (r) => words(r.customer_name).join(' ');

// ---------------------------------------------------------------------------- faits par mois
// rows : lignes de finance_billing_subs (dates en 'YYYY-MM-DD'). Renvoie, pour chaque mois
// demandé, les COMPTES bruts ; les KPI se calculent ensuite dans le navigateur.
//
// « Nouveaux abonnements issus d'un changement de propriétaire » (pour la Nouvelle MRR) : dans
// la même organisation, un abonnement ACTIVÉ le même mois qu'une résiliation CoO, pour le même
// client (même customer_id, ou même nom normalisé). Chaque résiliation CoO « consomme » au plus
// UN nouvel abonnement (le plus proche en date). Le nombre de rooftops, lui, retire le NOMBRE de
// résiliations CoO, comme le document Word.
function computeBillingFacts(rows, months, { canadaOrgs, usaOrgs, cooReasons, aliases, usaSnaps = {}, mrrStatuses = DEFAULT_MRR_STATUSES }) {
  const isCoo = cooMatcher(cooReasons);
  const can = new Set(canadaOrgs.map(String)), usa = new Set(usaOrgs.map(String));
  const want = new Set(months);
  const facts = {};
  const detail = {};
  for (const m of months) {
    facts[m] = {
      activations: 0, resellerActivations: 0, cooCancellations: 0, cancellations: 0,
      cancelMrr: 0, cooCancelMrr: 0, newMrrGross: 0, cooNewSubs: 0, cooNewMrr: 0,
      usaChurn: 0, usaMrrUsd: null, usaMrrSrc: null,
    };
    detail[m] = { activations: [], cancellations: [], usaChurn: [] };
  }
  const brief = (r, extra) => ({ org: r.org_id, sub: r.subscription_number, customer: r.customer_name, plan: r.plan_name, monthly: Math.round(r.monthly_amount * 100) / 100, ...extra });

  const newByMonth = {}; // mois → abonnements activés (Canada), pour le rapprochement CoO
  for (const r of rows) {
    const org = String(r.org_id);
    const am = r.activated_at ? r.activated_at.slice(0, 7) : null;
    const cm = r.cancelled_at ? r.cancelled_at.slice(0, 7) : null;
    const amt = Number(r.monthly_amount) || 0;
    if (can.has(org)) {
      if (am && want.has(am)) {
        const f = facts[am];
        f.activations++;
        f.newMrrGross += amt;
        const res = resellerOf(r.customer_name, aliases);
        if (res) f.resellerActivations++;
        (newByMonth[am] = newByMonth[am] || []).push(r);
        detail[am].activations.push(brief(r, { date: r.activated_at, reseller: res, dateSrc: r.activated_src !== 'activated_at' ? r.activated_src : undefined }));
      }
      if (cm && want.has(cm)) {
        const f = facts[cm];
        const coo = isCoo(r.cancel_reason);
        f.cancellations++;
        f.cancelMrr += amt;
        if (coo) { f.cooCancellations++; f.cooCancelMrr += amt; }
        detail[cm].cancellations.push(brief(r, { date: r.cancelled_at, reason: r.cancel_reason, coo }));
      }
    }
    if (usa.has(org) && cm && want.has(cm)) {
      facts[cm].usaChurn++;
      detail[cm].usaChurn.push(brief(r, { date: r.cancelled_at, reason: r.cancel_reason }));
    }
  }

  // Rapprochement CoO → nouvel abonnement du même client, même mois, même organisation.
  for (const m of months) {
    const pool = (newByMonth[m] || []).slice();
    const used = new Set();
    for (const c of detail[m].cancellations.filter((x) => x.coo)) {
      const cr = rows.find((r) => String(r.org_id) === c.org && r.subscription_number === c.sub);
      if (!cr) continue;
      const ck = customerKey(cr);
      let best = null;
      for (const n of pool) {
        if (used.has(n) || String(n.org_id) !== String(cr.org_id) || n.subscription_number === cr.subscription_number) continue;
        const same = (cr.customer_id && n.customer_id && cr.customer_id === n.customer_id) || (ck && customerKey(n) === ck);
        if (!same) continue;
        const dist = Math.abs(Date.parse(n.activated_at) - Date.parse(cr.cancelled_at));
        if (!best || dist < best.dist) best = { n, dist };
      }
      if (best) {
        used.add(best.n);
        facts[m].cooNewSubs++;
        facts[m].cooNewMrr += Number(best.n.monthly_amount) || 0;
        const d = detail[m].activations.find((x) => x.org === String(best.n.org_id) && x.sub === best.n.subscription_number);
        if (d) d.cooOf = cr.subscription_number;
      }
    }
  }

  // MRR des États-Unis à la fin du mois (en USD) : la PHOTO de la nuit qui suit la fin du mois
  // si elle existe (prise par la synchro de nuit), sinon une RECONSTITUTION à partir de la copie
  // locale : abonnements activés au plus tard ce jour-là et pas encore résiliés, au montant
  // ACTUEL (Zoho ne garde pas l'historique des prix dans la liste) — marquée comme telle.
  for (const m of months) {
    const end = monthEnd(m);
    const snap = usaSnaps[m];
    if (snap && snap.mrr != null) { facts[m].usaMrrUsd = snap.mrr; facts[m].usaMrrSrc = `snapshot:${snap.date}`; continue; }
    let total = 0, any = false;
    for (const r of rows) {
      if (!usa.has(String(r.org_id)) || !r.activated_at || r.activated_at > end) continue;
      if (r.cancelled_at) { if (r.cancelled_at <= end) continue; }
      else if (!mrrStatuses.has(r.status)) continue; // en pause aujourd'hui : 0 $ de MRR
      total += Number(r.monthly_amount) || 0; any = true;
    }
    facts[m].usaMrrUsd = any ? total : null;
    facts[m].usaMrrSrc = any ? 'reconstructed' : null;
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  for (const m of months) for (const k of ['cancelMrr', 'cooCancelMrr', 'newMrrGross', 'cooNewMrr']) facts[m][k] = r2(facts[m][k]);
  for (const m of months) if (facts[m].usaMrrUsd != null) facts[m].usaMrrUsd = r2(facts[m].usaMrrUsd);
  return { facts, detail };
}

// Photo la plus proche de la fin du mois : du dernier jour (inclus) au 2e jour du mois suivant,
// la plus tardive gagne (la nuit du 1er voit le mois entier).
function pickMonthEndSnaps(snapRows, months, orgIds) {
  const set = new Set(orgIds.map(String));
  const out = {};
  for (const m of months) {
    const lo = monthEnd(m), hi = addDays(monthEnd(m), 2);
    const byOrg = {};
    for (const s of snapRows) {
      if (!set.has(String(s.org_id)) || s.snap_date < lo || s.snap_date > hi) continue;
      if (!byOrg[s.org_id] || s.snap_date > byOrg[s.org_id].snap_date) byOrg[s.org_id] = s;
    }
    const got = Object.values(byOrg);
    if (got.length === set.size && got.length) {
      out[m] = { mrr: got.reduce((a, s) => a + Number(s.mrr), 0), date: got.map((s) => s.snap_date).sort()[0] };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- Zoho Books
const num = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[^0-9.\-]/g, '');
  const x = parseFloat(s);
  return Number.isFinite(x) ? x : null;
};
// Rapport « Profit and Loss » de Zoho Books → liste plate de comptes et de groupes. La forme
// exacte du JSON n'est pas documentée finement : on parcourt l'arbre et on garde tout nœud qui a
// un nom et un total. Un compte (account_id) est une feuille ; un groupe (sans account_id) est
// gardé aussi, sous une clé « grp: » + son chemin, pour que la CFO puisse rattacher un KPI à un
// TOTAL (ex. « Selling Expense ») plutôt qu'à une liste de comptes.
function flattenPnl(report) {
  const out = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, path)); return; }
    if (!node || typeof node !== 'object') return;
    const name = typeof node.name === 'string' ? node.name.trim() : (typeof node.account_name === 'string' ? node.account_name.trim() : null);
    const total = num(node.total != null ? node.total : node.amount);
    const children = node.account_transactions || node.accounts || node.sub_accounts || null;
    const id = node.account_id ? String(node.account_id) : null;
    if (name && total != null) {
      out.push({
        key: id ? `acc:${id}` : `grp:${[...path, name].join(' > ')}`.slice(0, 400),
        name: name.slice(0, 300),
        section: path.join(' > ').slice(0, 400),
        isGroup: !id,
        amount: Math.round(total * 100) / 100,
      });
    }
    if (children) walk(children, name ? [...path, name] : path);
    else if (!name) for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, path);
  };
  walk(report && (report.profit_and_loss || report.profitandloss || report), []);
  // Un même compte vu deux fois (rare) : on garde la première occurrence.
  const seen = new Set();
  return out.filter((a) => (seen.has(a.key) ? false : (seen.add(a.key), true)));
}

// Montant d'une ligne KPI à partir des comptes du mois et du rattachement de la CFO.
function glLineFromMapping(accounts, mapping) {
  if (!Array.isArray(mapping) || !mapping.length) return null;
  const by = new Map(accounts.map((a) => [a.key, a]));
  let total = 0, any = false;
  for (const m of mapping) {
    const a = by.get(m.key);
    if (!a) continue;
    total += (m.sign === -1 ? -1 : 1) * Number(a.amount);
    any = true;
  }
  // Rattaché mais absent ce mois-là = 0 $ (le compte n'a pas bougé), pas « inconnu ».
  return any ? Math.round(total * 100) / 100 : 0;
}

// Le refus d'une portée manquante doit se distinguer d'une panne : l'écran dit alors « Zoho
// Books à reconnecter » et propose la saisie manuelle.
function isScopeError(status, body) {
  const s = typeof body === 'object' && body ? JSON.stringify(body) : String(body || '');
  if (status === 401 && /scope|authori[sz]|permission|57/i.test(s)) return true;
  if (status === 403) return true;
  return /"code"\s*:\s*57\b|invalid.?oauth.?scope|not authori[sz]ed|insufficient.?scope|OAUTH_SCOPE_MISMATCH/i.test(s);
}

// ---------------------------------------------------------------------------- Banque du Canada
// Valet : { observations: [{ d: '2026-09-30', FXUSDCAD: { v: '1.3912' } }, …] }. Taux de fin de
// mois = la DERNIÈRE observation du mois (jour ouvrable), comme le demande le document Word.
function bocMonthEnds(body) {
  const obs = (body && body.observations) || [];
  const out = {};
  for (const o of obs) {
    const d = o && o.d;
    const v = num(o && o.FXUSDCAD && o.FXUSDCAD.v);
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d) || v == null || v <= 0 || v > 5) continue;
    const m = d.slice(0, 7);
    if (!out[m] || d > out[m].date) out[m] = { date: d, rate: v };
  }
  return out;
}

module.exports = {
  isMonth, addMonths, monthDiff, monthRange, monthEnd, addDays, torontoToday, torontoHour, lastCompleteMonth,
  zohoDate, subMonthlyAmountLocal, normalizeSub, DEFAULT_MRR_STATUSES, DEFAULT_ACTIVE_STATUSES,
  normReason, cooMatcher, words, buildResellerAliases, resellerOf,
  computeBillingFacts, pickMonthEndSnaps, flattenPnl, glLineFromMapping, isScopeError, bocMonthEnds, num,
};
