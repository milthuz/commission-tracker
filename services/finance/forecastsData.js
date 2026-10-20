// ============================================================================
// Module Finance — Prévisions (lot C) : lecture des données que Sales Hub possède déjà.
//
//   - MRR ajouté / nouveaux abonnements : table `finance_billing_subs` du lot KPI (B), lue
//     SI elle existe (sinon « source en attente » : la CFO saisit ses réels) ;
//   - nouveaux marchands : `crm_sold_deals` (date de vente figée), hors `excluded_deals` — même
//     expression que les cinq compteurs de points de server.js (référence QUALIFIÉE) ;
//   - paiements : `zentact_merchants` (activations, montants en DOLLARS) et
//     `zentact_merchant_revenue` (montants en CENTS, un rang par marchand et par mois) ;
//   - trésorerie : comptes bancaires Zoho Books (portée banking.READ — reconnexion de l'admin).
// Une instruction SQL par appel (PGlite).
// ============================================================================

const { ym, yearMonths } = require('./forecastsCompute');

const tableExists = async (pool, name) => {
  const r = await pool.query('SELECT to_regclass($1) AS t', [name]);
  return !!(r.rows[0] && r.rows[0].t);
};

// ---------------------------------------------------------------------------- ventes
// MRR ajouté = MÊMES définitions que l'onglet KPI (lot B, kpiCore.computeBillingFacts), sur les
// organisations « Canada » de ses réglages (finance_kpi_settings) :
//   MRR nouveau = MRR des activations − MRR des nouveaux abonnements issus d'un changement de
//                 propriétaire (CoO) ; MRR perdu = MRR des résiliations − MRR des résiliations CoO ;
//   MRR ajouté net = MRR nouveau − MRR perdu ; nouveaux abonnements = activations − nouveaux CoO.
// Sans le module KPI (banc d'essai, module absent) : repli sur une lecture simple de la table, CoO
// reconnu au début du motif. Toute erreur = « source en attente », jamais une page cassée.
async function kpiSettings(pool) {
  let defaults = { canadaOrgIds: ['697704869'], cooReasons: ['Change of Ownership – new sub created'] };
  try { defaults = { ...defaults, ...require('./kpi').DEFAULT_SETTINGS() }; } catch { /* lot B absent */ }
  try {
    if (await tableExists(pool, 'finance_kpi_settings')) {
      const r = await pool.query('SELECT data FROM finance_kpi_settings WHERE id = 1');
      if (r.rows[0] && r.rows[0].data) return { ...defaults, ...r.rows[0].data };
    }
  } catch { /* réglages illisibles : défauts */ }
  return defaults;
}

async function billingMrr(pool, year, months) {
  let core = null;
  try { core = require('./kpiCore'); } catch { core = null; }
  const settings = await kpiSettings(pool);
  const orgs = (settings.canadaOrgIds || []).map(String);
  const rows = (await pool.query(
    `SELECT org_id, subscription_number, customer_id, customer_name, plan_name, status,
            to_char(activated_at, 'YYYY-MM-DD') AS activated_at, ${core ? 'activated_src' : 'NULL AS activated_src'},
            to_char(cancelled_at, 'YYYY-MM-DD') AS cancelled_at, cancel_reason, monthly_amount::float8 AS monthly_amount
       FROM finance_billing_subs
      WHERE org_id = ANY($1) AND (EXTRACT(YEAR FROM activated_at) = $2 OR EXTRACT(YEAR FROM cancelled_at) = $2)`, [orgs, year])).rows;
  const out = { newMrr: months.map(() => 0), churnMrr: months.map(() => 0), newSubs: months.map(() => 0), orgs, definition: core ? 'kpi' : 'simple' };
  if (core && core.computeBillingFacts) {
    const res = core.computeBillingFacts(rows, months, { canadaOrgs: orgs, usaOrgs: [], cooReasons: settings.cooReasons || [], aliases: [] });
    const facts = (res && res.facts) || res || {};
    months.forEach((k, i) => {
      const f = facts[k] || {};
      out.newMrr[i] = (f.newMrrGross || 0) - (f.cooNewMrr || 0);
      out.churnMrr[i] = (f.cancelMrr || 0) - (f.cooCancelMrr || 0);
      out.newSubs[i] = (f.activations || 0) - (f.cooNewSubs || 0);
    });
  } else {
    const coo = /^change of ownership/i;
    for (const r of rows) {
      const amt = Number(r.monthly_amount) || 0;
      if (r.activated_at && r.activated_at.startsWith(`${year}-`)) { const i = Number(r.activated_at.slice(5, 7)) - 1; out.newMrr[i] += amt; out.newSubs[i]++; }
      if (r.cancelled_at && r.cancelled_at.startsWith(`${year}-`) && !coo.test(String(r.cancel_reason || '').trim())) out.churnMrr[Number(r.cancelled_at.slice(5, 7)) - 1] += amt;
    }
  }
  return out;
}

async function salesActuals(pool, year) {
  const months = yearMonths(year);
  const blank = () => months.map(() => null);
  const out = {
    mrr: { source: 'pending', values: blank(), newMrr: blank(), churnMrr: blank(), newSubs: blank() },
    merchants: { source: 'crm', values: blank() },
    installs: { source: 'none', values: blank() },
    payActivations: { source: 'zentact', values: blank() },
  };
  try {
    if (await tableExists(pool, 'finance_billing_subs')) {
      const any = await pool.query('SELECT COUNT(*)::int AS n FROM finance_billing_subs');
      if (any.rows[0].n > 0) {
        const b = await billingMrr(pool, year, months);
        out.mrr = { source: 'billing', definition: b.definition, orgs: b.orgs, newMrr: b.newMrr, churnMrr: b.churnMrr, newSubs: b.newSubs, values: months.map((_, i) => b.newMrr[i] - b.churnMrr[i]) };
      }
    }
  } catch (e) {
    out.mrr = { source: 'pending', error: 'billing_read_failed', values: blank(), newMrr: blank(), churnMrr: blank(), newSubs: blank() };
  }
  try {
    const d = await pool.query(
      `SELECT EXTRACT(MONTH FROM c.sold_date)::int AS m, COUNT(*)::int AS n FROM crm_sold_deals c
        WHERE NOT EXISTS (SELECT 1 FROM excluded_deals x WHERE x.deal_id = c.deal_id)
          AND EXTRACT(YEAR FROM c.sold_date) = $1 GROUP BY 1`, [year]);
    out.merchants.values = months.map(() => 0);
    for (const r of d.rows) out.merchants.values[r.m - 1] = r.n;
  } catch { out.merchants = { source: 'pending', values: blank() }; }
  try {
    const z = await pool.query(
      `SELECT EXTRACT(MONTH FROM activated_at)::int AS m, COUNT(*)::int AS n FROM zentact_merchants
        WHERE activated_at IS NOT NULL AND EXTRACT(YEAR FROM activated_at) = $1 GROUP BY 1`, [year]);
    out.payActivations.values = months.map(() => 0);
    for (const r of z.rows) out.payActivations.values[r.m - 1] = r.n;
  } catch { out.payActivations = { source: 'pending', values: blank() }; }
  return out;
}

// ---------------------------------------------------------------------------- paiements
// Équipe de conversion : les équipes qui ne comptent QUE les paiements (include_deals = false,
// include_payments = true — l'équipe « Payment conversion » de l'Admin), sauf choix explicite.
async function conversionTeams(pool) {
  try {
    const r = await pool.query('SELECT id, name, include_deals, include_payments FROM teams ORDER BY name');
    return r.rows.map((t) => ({ id: t.id, name: t.name, auto: t.include_deals === false && t.include_payments !== false }));
  } catch { return []; }
}

/**
 * Réels mensuels Zentact entre deux mois inclus (« YYYY-MM »).
 *  active    = marchands ayant traité dans le mois (au moins une transaction ou des frais) ;
 *  installs  = activations du mois hors équipe de conversion ; conv = activations de l'équipe ;
 *  churned   = actifs le mois précédent, sans activité ce mois-ci (approximation : Zentact ne
 *              date pas les fermetures) ;
 *  grossFees = frais perçus + autres revenus ; residual = profit de transaction + autres revenus
 *              (la marge de Cluster) — en DOLLARS (la table est en cents).
 */
async function paymentActuals(pool, fromYm, toYm, convTeamIds) {
  const [fy, fm] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  // Un mois de plus avant, pour le churn du premier mois.
  const pIdx = fy * 12 + fm - 2;
  const lo = Math.floor(pIdx / 12) * 100 + (pIdx % 12) + 1;
  const hi = ty * 100 + tm;
  let rev = [], act = [], last = null;
  try {
    rev = (await pool.query(
      `SELECT year, month, merchant_account_id AS id,
              (COALESCE(collected_fees_cents, 0) + COALESCE(other_revenue_cents, 0))::float8 AS gross,
              (COALESCE(transaction_profit_cents, 0) + COALESCE(other_revenue_cents, 0))::float8 AS profit
         FROM zentact_merchant_revenue
        WHERE (year * 100 + month) BETWEEN $1 AND $2
          AND (COALESCE(payments_count, 0) > 0 OR COALESCE(collected_fees_cents, 0) <> 0 OR COALESCE(other_revenue_cents, 0) <> 0)`, [lo, hi])).rows;
    last = (await pool.query('SELECT MAX(year * 100 + month) AS p FROM zentact_merchant_revenue')).rows[0].p;
  } catch { return { source: 'pending', months: [], lastActual: null }; }
  const ids = Array.isArray(convTeamIds) ? convTeamIds : null;
  try {
    act = (await pool.query(
      `SELECT EXTRACT(YEAR FROM z.activated_at)::int AS y, EXTRACT(MONTH FROM z.activated_at)::int AS m,
              COUNT(*) FILTER (WHERE t.id IS NOT NULL AND (${ids ? 't.id = ANY($3::int[])' : '(t.include_deals = false AND t.include_payments IS DISTINCT FROM false)'}))::int AS conv,
              COUNT(*)::int AS n
         FROM zentact_merchants z
         LEFT JOIN salespeople s ON LOWER(s.name) = LOWER(z.sales_rep_name)
         LEFT JOIN teams t ON t.id = s.team_id
        WHERE z.activated_at IS NOT NULL
          AND (EXTRACT(YEAR FROM z.activated_at)::int * 100 + EXTRACT(MONTH FROM z.activated_at)::int) BETWEEN $1 AND $2
        GROUP BY 1, 2`, ids ? [lo, hi, ids] : [lo, hi])).rows;
  } catch {
    // Pas de tables d'équipes (banc d'essai minimal) : toutes les activations sont des installations.
    try {
      act = (await pool.query(
        `SELECT EXTRACT(YEAR FROM activated_at)::int AS y, EXTRACT(MONTH FROM activated_at)::int AS m, 0 AS conv, COUNT(*)::int AS n
           FROM zentact_merchants WHERE activated_at IS NOT NULL
            AND (EXTRACT(YEAR FROM activated_at)::int * 100 + EXTRACT(MONTH FROM activated_at)::int) BETWEEN $1 AND $2 GROUP BY 1, 2`, [lo, hi])).rows;
    } catch { act = []; }
  }
  const byMonth = new Map();
  for (const r of rev) {
    const k = ym(r.year, r.month);
    if (!byMonth.has(k)) byMonth.set(k, { ids: new Set(), gross: 0, profit: 0 });
    const b = byMonth.get(k);
    b.ids.add(r.id); b.gross += Number(r.gross); b.profit += Number(r.profit);
  }
  const actBy = new Map(act.map((r) => [ym(r.y, r.m), r]));
  const lastActual = last ? ym(Math.floor(last / 100), last % 100) : null;
  const months = [];
  for (let i = fy * 12 + fm - 1; i <= ty * 12 + tm - 1; i++) {
    const k = ym(Math.floor(i / 12), (i % 12) + 1);
    if (lastActual && k > lastActual) break;
    const prevK = ym(Math.floor((i - 1) / 12), ((i - 1) % 12) + 1);
    const b = byMonth.get(k), p = byMonth.get(prevK);
    const a = actBy.get(k);
    let churned = null;
    if (p && b) { churned = 0; for (const id of p.ids) if (!b.ids.has(id)) churned++; }
    months.push({
      ym: k,
      active: b ? b.ids.size : 0,
      installs: a ? a.n - a.conv : 0,
      conv: a ? a.conv : 0,
      churned,
      grossFees: b ? b.gross / 100 : 0,
      residual: b ? b.profit / 100 : 0,
    });
  }
  return { source: lastActual ? 'zentact' : 'pending', months, lastActual };
}

// ---------------------------------------------------------------------------- trésorerie
// Comptes bancaires Zoho Books. Sans la portée banking.READ, Zoho répond 401 / code 57 : on le dit
// (« reconnecter Zoho Books ») au lieu d'inventer un solde. Une seule reprise sur 429 (20 s) ou 401.
async function booksBankAccounts(late, http) {
  if (!late || !late.getAdminBooksAuth) return { status: 'unavailable' };
  const org = process.env.ZOHO_ORG_ID;
  const once = async () => {
    const { accessToken, apiDomain } = await late.getAdminBooksAuth();
    return http.get(`${apiDomain}/books/v3/bankaccounts`, {
      params: { organization_id: org, filter_by: 'Status.Active' },
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }, validateStatus: () => true, timeout: 25000,
    });
  };
  let r;
  try {
    r = await once();
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 20000)); r = await once(); }
    else if (r.status === 401 && !(r.data && Number(r.data.code) === 57)) r = await once();
  } catch (e) {
    return { status: /connected|re-auth|revoked/i.test(String(e.message)) ? 'reconnect' : 'error' };
  }
  const code = r.data && Number(r.data.code);
  if (r.status === 401 || r.status === 403 || code === 57 || code === 14) return { status: 'reconnect' };
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.bankaccounts)) return { status: 'error', http: r.status };
  return {
    status: 'ok',
    fetchedAt: new Date().toISOString(),
    accounts: r.data.bankaccounts.map((a) => ({
      id: String(a.account_id), name: String(a.account_name || ''), bank: String(a.bank_name || ''),
      type: String(a.account_type || ''), currency: String(a.currency_code || ''),
      balance: Number(a.balance) || 0,
    })),
  };
}

module.exports = { salesActuals, paymentActuals, conversionTeams, booksBankAccounts, tableExists };
