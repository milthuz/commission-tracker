// ============================================================================
// Module Finance — lot F : suggestions de drivers selon l'historique (permission
// `finance:suggestions`). Demande de la CFO : « driver forecast suggestions based off historical
// data, with the choice to select it or override ».
//
// GET /api/finance/suggestions[?window=3|6|12][&method=avg|trend|seasonal]
//   → pour chaque driver dont Sales Hub a de l'historique, une suggestion NON appliquée ; le
//     serveur n'écrit RIEN au budget (appliquer = le navigateur, applyDriverValues, comme une
//     saisie de la CFO, avec le verrou d'approbation et la concurrence optimiste habituels).
//
// Sources : Zoho Billing (finance_billing_subs : ajouts, revendeurs, attrition, ARPU, part de
// nouveaux clients), Zentact (zentact_merchants, zentact_merchant_revenue : ajouts et ARPU des
// paiements). Tout le reste est listé dans `unavailable` avec sa raison — rien n'est inventé.
// Les calculs vivent dans suggestionsCore.js (purs, testés à la main).
//
// Lecture = finance:view + finance:suggestions. Mode démo bloqué (vrais chiffres).
// ============================================================================

const K = require('./kpiCore');
const SC = require('./suggestionsCore');

const PERM_VIEW = 'finance:view';
const PERM_EDIT = 'finance:edit';
const PERM_SUGGESTIONS = 'finance:suggestions';
const PERM_AI = 'finance:ai_budget';
const HISTORY_MONTHS = 24;
const METHODS = ['avg', 'trend', 'seasonal'];
const DEFAULT_XPERIO_ORG = '905113716';

// Lecture tolérante : une table absente (module pas encore initialisé, Zentact non installé)
// donne `null`, jamais une erreur 500.
async function tryRows(pool, sql, params) {
  try { return (await pool.query(sql, params)).rows; } catch { return null; }
}

// Budget consolidé de l'exercice + valeurs courantes des drivers (état de la CFO, sinon défauts ×12).
async function loadBudgetAndCurrent(pool, fy) {
  const b = (await pool.query("SELECT id, fiscal_year, status, reference FROM finance_budgets WHERE fiscal_year = $1 AND entity = 'consolidated'", [fy])).rows[0];
  if (!b) return null;
  const st = (await pool.query("SELECT data FROM finance_state WHERE budget_id = $1 AND section = 'drivers'", [b.id])).rows[0];
  const drv = (st && st.data && st.data.drv) || {};
  const defaults = (b.reference && b.reference.drvDefaults) || {};
  const current = {};
  for (const k of Object.keys(defaults)) {
    const a = drv[k];
    current[k] = Array.isArray(a) && a.length === 12 ? a.map(Number) : Array(12).fill(Number(defaults[k]) || 0);
  }
  return { budget: b, current, keys: Object.keys(defaults) };
}

// Tout ce qu'il faut pour calculer, lu en base. `kit` : trousse de routes.js.
async function loadInputs(kit, ensureKpi) {
  const pool = kit.pool;
  await ensureKpi();
  let late = {};
  try { late = kit.late() || {}; } catch { late = {}; }

  // Réglages du KPI (organisations Canada / É.-U., motifs de changement de propriétaire, alias
  // de revendeurs) : les MÊMES que l'onglet KPI, pour que les ajouts suggérés collent à ses chiffres.
  const { DEFAULT_SETTINGS } = require('./kpi');
  const srow = await tryRows(pool, 'SELECT data FROM finance_kpi_settings WHERE id = 1');
  const settings = { ...DEFAULT_SETTINGS(), ...((srow && srow[0] && srow[0].data) || {}) };
  let resellerRows = [];
  if (settings.useResellersTable) resellerRows = (await tryRows(pool, 'SELECT name, name_aliases, active FROM resellers')) || [];
  const aliases = K.buildResellerAliases(resellerRows, settings.resellerAliases);

  const names = late.ZOHO_BILLING_ORG_NAMES || {};
  const xpId = Object.keys(names).find((id) => /xperio/i.test(String(names[id]))) || process.env.FINANCE_XPERIO_ORG_ID || DEFAULT_XPERIO_ORG;
  const ctx = {
    canadaOrgs: settings.canadaOrgIds, usaOrgs: settings.usaOrgIds, xpOrgs: [xpId],
    cooReasons: settings.cooReasons, aliases, mrrStatuses: late.MRR_STATUSES || K.DEFAULT_MRR_STATUSES,
  };
  const orgs = [...new Set([...ctx.canadaOrgs, ...ctx.usaOrgs, ...ctx.xpOrgs].map(String))];
  const billingRows = await tryRows(pool,
    `SELECT org_id, subscription_number, customer_id, customer_name, status,
            to_char(activated_at, 'YYYY-MM-DD') AS activated_at, to_char(cancelled_at, 'YYYY-MM-DD') AS cancelled_at,
            cancel_reason, monthly_amount::float8 AS monthly_amount
       FROM finance_billing_subs WHERE org_id = ANY($1)`, [orgs]);
  const merchants = await tryRows(pool, "SELECT to_char(activated_at, 'YYYY-MM-DD') AS activated_at FROM zentact_merchants WHERE activated_at IS NOT NULL");
  const revenue = await tryRows(pool,
    `SELECT year, month, currency, total_volume_cents::float8 AS total_volume_cents, payments_count,
            transaction_profit_cents::float8 AS transaction_profit_cents, other_revenue_cents::float8 AS other_revenue_cents
       FROM zentact_merchant_revenue`);
  return { ctx, billingRows, zentact: { merchants, revenue } };
}

// Calcul complet (partagé avec le brouillon de l'IA, aiBudget.js).
async function computeSuggestions(kit, ensureKpi, opts = {}) {
  const fy = Number(opts.fy) || 2027;
  const bc = await loadBudgetAndCurrent(kit.pool, fy);
  if (!bc) return { empty: true, fiscalYear: fy };
  const inputs = await loadInputs(kit, ensureKpi);
  const last = K.lastCompleteMonth(opts.now || new Date());
  const months = K.monthRange(K.addMonths(last, -(HISTORY_MONTHS - 1)), last);
  const targets = Array.from({ length: 12 }, (_, i) => `${bc.budget.fiscal_year}-${String(i + 1).padStart(2, '0')}`);
  const r = SC.suggestAll({
    months, targets, keys: bc.keys, billingRows: inputs.billingRows, zentact: inputs.zentact, ctx: inputs.ctx,
    window: opts.window, method: opts.method, current: bc.current,
  });
  return {
    empty: false,
    budget: { id: bc.budget.id, fiscalYear: bc.budget.fiscal_year, status: bc.budget.status },
    meta: {
      lastClosedMonth: last, months, targets, window: [3, 6, 12].includes(opts.window) ? opts.window : 6,
      generatedAt: new Date().toISOString(),
      sources: { billing: !!(inputs.billingRows && inputs.billingRows.length), zentact: !!(inputs.zentact.merchants && inputs.zentact.merchants.length) },
    },
    current: bc.current, keys: bc.keys,
    suggestions: r.suggestions, unavailable: r.unavailable,
  };
}

function register(app, kit) {
  const { pool, authenticateToken } = kit;
  if (!pool) return;
  let ready = null;
  const ensureKpi = () => (ready = ready || Promise.resolve().then(() => require('./kpi').ensureSchema(pool)).catch((e) => { ready = null; throw e; }));

  app.get('/api/finance/suggestions', authenticateToken, async (req, res) => {
    try {
      if (!(await kit.guardAll(req, res, [PERM_SUGGESTIONS, PERM_VIEW]))) return;
      let window;
      if (req.query.window !== undefined) {
        window = Number(req.query.window);
        if (![3, 6, 12].includes(window)) return res.status(400).json({ error: 'bad_window' });
      }
      const method = req.query.method;
      if (method !== undefined && !METHODS.includes(method)) return res.status(400).json({ error: 'bad_method' });
      const r = await computeSuggestions(kit, ensureKpi, { fy: req.query.fy, window, method });
      const caps = { canApply: await kit.can(req, PERM_EDIT), canAiBudget: aiEnabled() && await kit.can(req, PERM_AI) };
      if (r.empty) return res.json({ empty: true, fiscalYear: r.fiscalYear, suggestions: [], unavailable: [], caps });
      res.json({ empty: false, budget: r.budget, meta: r.meta, suggestions: r.suggestions, unavailable: r.unavailable, caps });
    } catch (e) {
      console.error('finance suggestions:', e.message);
      res.status(500).json({ error: 'load_failed' });
    }
  });
}

// Brouillon IA : ÉTEINT par défaut (décision de la CFO, 2026-10-21) ; s'allume avec FINANCE_AI_ENABLED=true.
const aiEnabled = () => process.env.FINANCE_AI_ENABLED === 'true';

module.exports = { register, computeSuggestions, aiEnabled, PERM_SUGGESTIONS, PERM_AI };
