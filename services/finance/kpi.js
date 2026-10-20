// ============================================================================
// Module Finance — onglet KPI (lot B) : « MoM BvA, 12 mois glissants », demandé par la CFO.
// Mise en page de l'onglet « YTD KPI » de son classeur (une ligne par KPI, une colonne par mois),
// liste et sources des KPI du document Word « KPI Dashboard » (design/finance/kpi/).
//
// Le serveur ASSEMBLE les données, le navigateur CALCULE (src/pages/Finance/Kpi/kpiModel.ts) :
//   - Zoho Billing → finance_billing_subs (copie complète des 3 organisations, chaque nuit),
//     comptes par mois faits ici (kpiCore.computeBillingFacts) ;
//   - Zoho Books → rapport P&L mensuel (finance_gl_raw) → lignes KPI selon le RATTACHEMENT de la
//     CFO (réglages, jamais deviné dans le code) → finance_gl_monthly ; notes de crédit du mois ;
//   - Banque du Canada → taux USD/CAD de fin de mois (finance_fx_monthly) ;
//   - Zentact → marchands Adyen actifs (rooftops du « Payments ARPU ») ;
//   - la CFO → budget KPI (grille, prérempli dans le navigateur par le modèle FY2027 pour 2027),
//     saisies manuelles (GL, taux) et corrections des réels (cellules jaunes, journalisées).
//
// Permissions : lecture = finance:view + finance:kpi ; écriture (budget, corrections, réglages,
// synchro) = + finance:edit. Mode démo bloqué (vrais chiffres). Journal : entity_type finance_kpi.
//
// ⚠️ JAMAIS TESTÉ CONTRE LE VRAI ZOHO (ni la Banque du Canada) — voir kpiSync.js.
// ============================================================================

const C = require('./kpiCore');
const S = require('./kpiSync');

const PERM_KPI = 'finance:kpi';
const PERM_VIEW = 'finance:view';
const PERM_EDIT = 'finance:edit';
const ENTITY = 'finance_kpi';
const MAX_ABS = 1e10;
const MANUAL_SYNC_EVERY_MS = 5 * 60 * 1000;
const SAVE_LOG_EVERY_MS = 15 * 60 * 1000;
const MAX_MONTHS = 60;

// Lignes de l'onglet (même liste, même ordre que kpiModel.ts — le banc d'essai les compare).
const KPI_KEYS = [
  'canNew', 'resellerAdds', 'coo', 'newRooftops', 'churn', 'usaChurn', 'totalChurn',
  'newMrr', 'churnMrr', 'usaMrrUsd', 'fxUsdCad', 'usaMrrCad', 'totalMrr',
  'newArpu', 'churnArpu', 'rooftopIncrease', 'mrrIncrease', 'totalRooftops', 'arpu',
  'sellingExpense', 'coa', 'subscriptionRevenue', 'arpuSaas', 'adyenIncome', 'adyenRooftops', 'paymentsArpu',
  'saasCreditNotes',
];
// Lignes alimentées par Zoho Books : une saisie de la CFO y est une SOURCE (« manuel », remplace
// Books), rangée avec les montants de Books. Clé de ligne KPI → ligne du grand livre.
const GL_ROW = { totalMrr: 'recurringRevenue', sellingExpense: 'sellingExpense', subscriptionRevenue: 'subscriptionRevenue', adyenIncome: 'adyenIncome', saasCreditNotes: 'saasCreditNotes' };
const GL_MAPPED = ['recurringRevenue', 'sellingExpense', 'subscriptionRevenue', 'adyenIncome'];

// Libellés du modèle Excel téléchargeable (le reste de l'interface est traduit côté navigateur).
const LABELS = {
  canNew: ['Canada New Rooftops', 'Nouveaux rooftops Canada'], resellerAdds: ['Reseller Activations', 'Activations revendeurs'],
  coo: ['Change of Ownership – new sub created', 'Changement de propriétaire – nouvel abonnement'], newRooftops: ['Total New Rooftops', 'Total nouveaux rooftops'],
  churn: ['Churn (Canada)', 'Attrition (Canada)'], usaChurn: ['USA Churn', 'Attrition É.-U.'], totalChurn: ['Total Churn', 'Attrition totale'],
  newMrr: ['Total New MRR', 'Nouvelle MRR totale'], churnMrr: ['Churn MRR', 'MRR perdue'], usaMrrUsd: ['USA Total MRR (USD)', 'MRR totale É.-U. (USD)'],
  fxUsdCad: ['USD/CAD month-end rate', 'Taux USD/CAD fin de mois'], usaMrrCad: ['USA Total MRR (CAD)', 'MRR totale É.-U. (CAD)'],
  totalMrr: ['Total MRR (Recurring revenue)', 'MRR totale (revenus récurrents)'], newArpu: ['New ARPU', 'ARPU nouveaux'], churnArpu: ['Churn ARPU', 'ARPU perdus'],
  rooftopIncrease: ['Rooftop Increase', 'Hausse des rooftops'], mrrIncrease: ['MRR Increase', 'Hausse de la MRR'], totalRooftops: ['Total Rooftops', 'Total des rooftops'],
  arpu: ['ARPU', 'ARPU'], sellingExpense: ['Selling Expense', 'Frais de vente'], coa: ['Cost of Acquisition', 'Coût d\'acquisition'],
  subscriptionRevenue: ['Subscription Revenue', 'Revenus d\'abonnement'], arpuSaas: ['ARPU SaaS', 'ARPU SaaS'], adyenIncome: ['Adyen Income', 'Revenus Adyen'],
  adyenRooftops: ['Adyen Rooftops', 'Rooftops Adyen'], paymentsArpu: ['Payments ARPU', 'ARPU paiements'], saasCreditNotes: ['Credit notes for the month', 'Notes de crédit du mois'],
};

// Réglages par défaut. Les alias de revendeurs sont ceux du document Word (Lirette, Jinctech,
// SC, Sino), appliqués en MOTS ENTIERS ; s'y ajoutent les revendeurs de la table `resellers`.
const DEFAULT_SETTINGS = () => ({
  canadaOrgIds: ['697704869'],
  usaOrgIds: ['802470810'],
  cooReasons: ['Change of Ownership – new sub created'],
  resellerAliases: ['Lirette', 'Jinctech', 'SC', 'Sino'],
  useResellersTable: true,
  opening: null, // { month: 'YYYY-MM', value } = total des rooftops à la FIN de ce mois
  glMapping: { recurringRevenue: [], sellingExpense: [], subscriptionRevenue: [], adyenIncome: [] },
});

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_billing_subs (
      org_id              TEXT NOT NULL,
      subscription_number TEXT NOT NULL,
      subscription_id     TEXT,
      customer_id         TEXT,
      customer_name       TEXT NOT NULL DEFAULT '',
      plan_code           TEXT,
      plan_name           TEXT,
      status              TEXT NOT NULL DEFAULT '',
      activated_at        DATE,
      activated_src       TEXT,
      cancelled_at        DATE,
      cancel_reason       TEXT,
      monthly_amount      NUMERIC NOT NULL DEFAULT 0,
      currency            TEXT,
      raw_updated_at      TEXT,
      synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, subscription_number)
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS finance_billing_subs_act ON finance_billing_subs (org_id, activated_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS finance_billing_subs_can ON finance_billing_subs (org_id, cancelled_at)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_billing_mrr_snap (
      org_id       TEXT NOT NULL,
      snap_date    DATE NOT NULL,
      mrr          NUMERIC NOT NULL,
      active_count INT NOT NULL DEFAULT 0,
      captured_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, snap_date)
    )`);
  // Comptes bruts du rapport P&L de Books, par mois (pour le rattachement de la CFO).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_gl_raw (
      month        DATE NOT NULL,
      account_key  TEXT NOT NULL,
      account_name TEXT NOT NULL,
      section      TEXT NOT NULL DEFAULT '',
      is_group     BOOLEAN NOT NULL DEFAULT FALSE,
      amount       NUMERIC NOT NULL,
      PRIMARY KEY (month, account_key)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_gl_raw_months (
      month     DATE PRIMARY KEY,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accounts  INT NOT NULL DEFAULT 0
    )`);
  // Une ligne par source : 'books' (calculée) et 'manual' (CFO) coexistent ; manuel gagne.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_gl_monthly (
      month      DATE NOT NULL,
      line_key   TEXT NOT NULL,
      source     TEXT NOT NULL CHECK (source IN ('books', 'manual')),
      amount     NUMERIC NOT NULL,
      note       TEXT,
      version    INT NOT NULL DEFAULT 1,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (month, line_key, source)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_fx_monthly (
      month      DATE NOT NULL,
      source     TEXT NOT NULL CHECK (source IN ('boc', 'manual')),
      usdcad     NUMERIC NOT NULL,
      obs_date   DATE,
      note       TEXT,
      version    INT NOT NULL DEFAULT 1,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (month, source)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_kpi_budget (
      month      DATE NOT NULL,
      kpi_key    TEXT NOT NULL,
      value      NUMERIC NOT NULL,
      version    INT NOT NULL DEFAULT 1,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (month, kpi_key)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_kpi_actual_override (
      month      DATE NOT NULL,
      kpi_key    TEXT NOT NULL,
      value      NUMERIC NOT NULL,
      note       TEXT,
      version    INT NOT NULL DEFAULT 1,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (month, kpi_key)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_kpi_settings (
      id         INT PRIMARY KEY CHECK (id = 1),
      data       JSONB NOT NULL,
      version    INT NOT NULL DEFAULT 1,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_kpi_sync_status (
      source      TEXT PRIMARY KEY,
      state       TEXT NOT NULL,
      last_try_at TIMESTAMPTZ,
      last_ok_at  TIMESTAMPTZ,
      last_error  TEXT,
      detail      JSONB
    )`);
}

// ---------------------------------------------------------------------------- validation
const finite = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < MAX_ABS;
const strList = (v, max, len) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.trim().length > 0 && x.length <= len);

function validateSettings(d, knownOrgs) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'bad_settings';
  const out = DEFAULT_SETTINGS();
  if (d.canadaOrgIds !== undefined) { if (!strList(d.canadaOrgIds, 5, 40) || (knownOrgs.length && !d.canadaOrgIds.every((o) => knownOrgs.includes(o)))) return 'bad_orgs'; out.canadaOrgIds = d.canadaOrgIds; }
  if (d.usaOrgIds !== undefined) { if (!strList(d.usaOrgIds, 5, 40) || (knownOrgs.length && !d.usaOrgIds.every((o) => knownOrgs.includes(o)))) return 'bad_orgs'; out.usaOrgIds = d.usaOrgIds; }
  if (out.canadaOrgIds.some((o) => out.usaOrgIds.includes(o))) return 'orgs_overlap';
  if (d.cooReasons !== undefined) { if (!strList(d.cooReasons, 20, 200)) return 'bad_coo_reasons'; out.cooReasons = d.cooReasons.map((s) => s.trim()); }
  if (d.resellerAliases !== undefined) {
    if (!strList(d.resellerAliases, 100, 120)) return 'bad_aliases';
    // Un alias d'une seule lettre attraperait n'importe quel nom.
    if (d.resellerAliases.some((a) => C.words(a).join('').length < 2)) return 'alias_too_short';
    out.resellerAliases = d.resellerAliases.map((s) => s.trim());
  }
  if (d.useResellersTable !== undefined) { if (typeof d.useResellersTable !== 'boolean') return 'bad_resellers_table'; out.useResellersTable = d.useResellersTable; }
  if (d.opening !== undefined && d.opening !== null) {
    if (!C.isMonth(d.opening.month) || !finite(d.opening.value) || d.opening.value < 0) return 'bad_opening';
    out.opening = { month: d.opening.month, value: d.opening.value };
  } else if (d.opening === null) out.opening = null;
  if (d.glMapping !== undefined) {
    if (!d.glMapping || typeof d.glMapping !== 'object') return 'bad_mapping';
    for (const [line, list] of Object.entries(d.glMapping)) {
      if (!GL_MAPPED.includes(line)) return `unknown_line:${line}`;
      if (!Array.isArray(list) || list.length > 200) return `bad_mapping:${line}`;
      for (const m of list) if (!m || typeof m.key !== 'string' || m.key.length > 400 || (m.sign !== undefined && m.sign !== 1 && m.sign !== -1)) return `bad_mapping:${line}`;
      out.glMapping[line] = list.map((m) => ({ key: m.key, sign: m.sign === -1 ? -1 : 1 }));
    }
  }
  return out;
}

const monthDate = (m) => `${m}-01`;

function register(app, kit) {
  const { pool, authenticateToken, logActivity } = kit;
  if (!pool) return;
  let ready = null;
  const schema = () => (ready = ready || ensureSchema(pool).catch((e) => { ready = null; throw e; }));
  schema().catch((e) => console.error('finance kpi schema:', e.message));

  const late = () => { try { return kit.late() || {}; } catch { return {}; } };
  const knownOrgs = () => (late().ZOHO_BILLING_ORG_IDS || []).map(String);
  const orgNames = () => late().ZOHO_BILLING_ORG_NAMES || {};

  const canRead = async (req, res) => { if (!(await kit.guardAll(req, res, [PERM_KPI, PERM_VIEW]))) return false; await schema(); return true; };
  const canWrite = async (req, res) => { if (!(await kit.guardAll(req, res, [PERM_KPI, PERM_VIEW, PERM_EDIT]))) return false; await schema(); return true; };
  const lastLog = new Map();
  const throttledLog = async (k, ...args) => {
    const now = Date.now();
    if (lastLog.has(k) && now - lastLog.get(k) < SAVE_LOG_EVERY_MS) return;
    lastLog.set(k, now);
    await logActivity(...args);
  };

  async function loadSettings() {
    const r = await pool.query('SELECT data, version, updated_by, updated_at FROM finance_kpi_settings WHERE id = 1');
    const row = r.rows[0];
    return { data: { ...DEFAULT_SETTINGS(), ...((row && row.data) || {}) }, version: row ? row.version : 0, updatedBy: row ? row.updated_by : null, updatedAt: row ? row.updated_at : null };
  }

  async function resellerAliases(settings) {
    let rows = [];
    if (settings.useResellersTable) {
      try { rows = (await pool.query('SELECT name, name_aliases, active FROM resellers')).rows; } catch { rows = []; }
    }
    return C.buildResellerAliases(rows, settings.resellerAliases);
  }

  // Faits Billing des mois demandés (et le détail, pour l'explication d'une cellule).
  async function billingFacts(months, settings) {
    const from = monthDate(months[0]), to = C.monthEnd(months[months.length - 1]);
    const rows = (await pool.query(
      `SELECT org_id, subscription_number, customer_id, customer_name, plan_name, status,
              to_char(activated_at, 'YYYY-MM-DD') AS activated_at, activated_src,
              to_char(cancelled_at, 'YYYY-MM-DD') AS cancelled_at, cancel_reason, monthly_amount::float8 AS monthly_amount
         FROM finance_billing_subs
        WHERE (org_id = ANY($1) AND ((activated_at BETWEEN $3::date AND $4::date) OR (cancelled_at BETWEEN $3::date AND $4::date)))
           OR org_id = ANY($2)`,
      [settings.canadaOrgIds, settings.usaOrgIds, from, to])).rows;
    const snaps = (await pool.query(
      `SELECT org_id, to_char(snap_date, 'YYYY-MM-DD') AS snap_date, mrr::float8 AS mrr FROM finance_billing_mrr_snap
        WHERE org_id = ANY($1) AND snap_date BETWEEN $2::date AND ($3::date + 2)`, [settings.usaOrgIds, from, to])).rows;
    const L = late();
    return C.computeBillingFacts(rows, months, {
      canadaOrgs: settings.canadaOrgIds, usaOrgs: settings.usaOrgIds, cooReasons: settings.cooReasons,
      aliases: await resellerAliases(settings), usaSnaps: C.pickMonthEndSnaps(snaps, months, settings.usaOrgIds),
      mrrStatuses: L.MRR_STATUSES || C.DEFAULT_MRR_STATUSES,
    });
  }

  // Marchands Adyen (Zentact) ACTIFS aujourd'hui et activés au plus tard à la fin du mois : la
  // seule source datée du parc Adyen. Un marchand parti depuis n'est plus « ACTIVE » : les mois
  // anciens sont donc légèrement SOUS-estimés (écart signalé à la CFO).
  async function adyenRooftops(months) {
    try {
      const r = await pool.query(
        `SELECT to_char(activated_at, 'YYYY-MM') AS m, COUNT(*)::int AS n FROM zentact_merchants
          WHERE UPPER(status) = 'ACTIVE' AND activated_at IS NOT NULL GROUP BY 1`);
      const by = Object.fromEntries(r.rows.map((x) => [x.m, x.n]));
      const keys = Object.keys(by).sort();
      const out = {};
      for (const m of months) out[m] = keys.filter((k) => k <= m).reduce((a, k) => a + by[k], 0);
      return out;
    } catch { return null; }
  }

  const vOut = (r) => ({ v: Number(r.value != null ? r.value : r.amount), note: r.note || null, by: r.updated_by, at: r.updated_at, version: r.version });

  async function assemble(end, settings) {
    const windowStart = C.addMonths(end, -11);
    let dataStart = C.addMonths(windowStart, -1);
    if (settings.opening && C.monthDiff(settings.opening.month, dataStart) > 0) dataStart = settings.opening.month;
    if (C.monthDiff(dataStart, end) >= MAX_MONTHS) dataStart = C.addMonths(end, -(MAX_MONTHS - 1));
    const months = C.monthRange(dataStart, end);
    const [{ facts }, ady, gl, fx, bud, ovr] = await Promise.all([
      billingFacts(months, settings),
      adyenRooftops(months),
      pool.query(`SELECT to_char(month, 'YYYY-MM') AS m, line_key, source, amount::float8 AS amount, note, version, updated_by, updated_at
                    FROM finance_gl_monthly WHERE month BETWEEN $1::date AND $2::date`, [monthDate(dataStart), monthDate(end)]),
      pool.query(`SELECT to_char(month, 'YYYY-MM') AS m, source, usdcad::float8 AS usdcad, to_char(obs_date, 'YYYY-MM-DD') AS obs_date, note, version, updated_by, updated_at
                    FROM finance_fx_monthly WHERE month BETWEEN $1::date AND $2::date`, [monthDate(dataStart), monthDate(end)]),
      pool.query(`SELECT to_char(month, 'YYYY-MM') AS m, kpi_key, value::float8 AS value, version, updated_by, updated_at
                    FROM finance_kpi_budget WHERE month BETWEEN $1::date AND $2::date`, [monthDate(dataStart), monthDate(end)]),
      pool.query(`SELECT to_char(month, 'YYYY-MM') AS m, kpi_key, value::float8 AS value, note, version, updated_by, updated_at
                    FROM finance_kpi_actual_override WHERE month BETWEEN $1::date AND $2::date`, [monthDate(dataStart), monthDate(end)]),
    ]);
    for (const m of months) {
      const f = facts[m];
      f.adyenRooftops = ady ? ady[m] : null;
      f.gl = {};
      for (const line of Object.values(GL_ROW)) f.gl[line] = { value: null, src: null, books: null, manual: null };
      f.fx = { value: null, src: null, boc: null, manual: null };
    }
    for (const r of gl.rows) {
      const e = facts[r.m] && facts[r.m].gl[r.line_key];
      if (!e) continue;
      if (r.source === 'books') e.books = { v: r.amount, note: r.note, at: r.updated_at };
      else e.manual = vOut(r);
    }
    for (const r of fx.rows) {
      const e = facts[r.m] && facts[r.m].fx;
      if (!e) continue;
      if (r.source === 'boc') e.boc = { v: r.usdcad, date: r.obs_date };
      else e.manual = { ...vOut({ ...r, value: r.usdcad }) };
    }
    for (const m of months) {
      for (const e of Object.values(facts[m].gl)) {
        if (e.manual) { e.value = e.manual.v; e.src = 'manual'; } else if (e.books) { e.value = e.books.v; e.src = 'books'; }
      }
      const x = facts[m].fx;
      if (x.manual) { x.value = x.manual.v; x.src = 'manual'; } else if (x.boc) { x.value = x.boc.v; x.src = 'boc'; }
    }
    const budget = {}, overrides = {};
    for (const r of bud.rows) (budget[r.m] = budget[r.m] || {})[r.kpi_key] = vOut(r);
    for (const r of ovr.rows) (overrides[r.m] = overrides[r.m] || {})[r.kpi_key] = vOut(r);
    return { end, windowStart, months, facts, budget, overrides };
  }

  async function sourcesStatus() {
    const r = await pool.query('SELECT source, state, last_try_at, last_ok_at, last_error, detail FROM finance_kpi_sync_status ORDER BY source');
    return r.rows.map((x) => ({ source: x.source, state: x.state, lastTryAt: x.last_try_at, lastOkAt: x.last_ok_at, error: x.last_error, detail: x.detail }));
  }

  // ------------------------------------------------------------------------ synchronisation
  let running = null;
  let lastManual = 0;
  async function runSync({ full, actor }) {
    if (running) return running;
    running = (async () => {
      const L = late();
      const settings = (await loadSettings()).data;
      const today = C.torontoToday();
      const cur = today.slice(0, 7);
      const back = full ? 25 : 3;
      const months = C.monthRange(C.addMonths(cur, -back), cur);
      const result = {};
      let owner = null;
      try {
        if (!L.getAdminBooksAuth || !L.fetchBillingSubs) throw new Error('zoho_helpers_unavailable');
        if (L.acquireSaasScanLock) {
          owner = await L.acquireSaasScanLock('finance_kpi');
          if (!owner) { await S.setStatus(pool, 'zoho', 'busy', { error: 'zoho_scan_lock_busy' }); result.zoho = 'busy'; }
        }
        if (!L.acquireSaasScanLock || owner) {
          const auth = await L.getAdminBooksAuth();
          result.billing = await S.syncBilling(pool, L, auth);
          result.books = await S.syncBooksPnl(pool, L, auth, months, settings.glMapping);
          result.creditNotes = await S.syncCreditNotes(pool, L, auth, months);
          await S.setStatus(pool, 'zoho', 'ok', { ok: true });
        }
      } catch (e) {
        result.zoho = e.message;
        await S.setStatus(pool, 'zoho', 'error', { error: e.message });
      } finally {
        if (owner && L.releaseSaasScanLock) await L.releaseSaasScanLock(owner).catch(() => {});
      }
      result.fx = await S.syncFx(pool, months[0], today);
      await S.setStatus(pool, full ? 'run:full' : 'run:nightly', 'ok', { ok: true, detail: { actor } });
      return result;
    })().finally(() => { running = null; });
    return running;
  }

  if (kit.runsJobs) {
    // Chaque quart d'heure : la synchro de nuit (entre 1 h et 5 h, heure de Montréal) si elle n'a
    // pas déjà tourné aujourd'hui ; une synchro COMPLÈTE la toute première fois.
    const tick = async () => {
      try {
        await schema();
        const st = (await pool.query("SELECT source, to_char(last_ok_at AT TIME ZONE 'America/Toronto', 'YYYY-MM-DD') AS d FROM finance_kpi_sync_status WHERE source IN ('run:nightly', 'run:full')")).rows;
        if (!st.length) { await runSync({ full: true, actor: 'system' }); return; }
        const h = C.torontoHour();
        if (h < 1 || h > 5) return;
        const today = C.torontoToday();
        if (st.some((x) => x.d === today)) return;
        await runSync({ full: false, actor: 'system' });
      } catch (e) { console.warn('finance kpi nightly:', e.message); }
    };
    const t0 = setTimeout(tick, 3 * 60 * 1000); if (t0.unref) t0.unref();
    const ti = setInterval(tick, 15 * 60 * 1000); if (ti.unref) ti.unref();
  }

  // ------------------------------------------------------------------------ lecture
  app.get('/api/finance/kpi', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res))) return;
      const def = C.lastCompleteMonth();
      const cur = C.torontoToday().slice(0, 7);
      const end = req.query.end ? String(req.query.end) : def;
      if (!C.isMonth(end) || C.monthDiff(end, cur) < 0) return res.status(400).json({ error: 'bad_end' });
      const st = await loadSettings();
      const data = await assemble(end, st.data);
      const canEdit = await kit.can(req, PERM_EDIT);
      const sources = await sourcesStatus();
      // Sans une copie Billing réussie des organisations Canada ET É.-U., tous les comptes
      // vaudraient 0 : le navigateur les affiche alors vides, pas à zéro.
      const okOrgs = new Set(sources.filter((s) => s.source.startsWith('billing:') && s.lastOkAt).map((s) => s.source.slice(8)));
      const billingReady = [...st.data.canadaOrgIds, ...st.data.usaOrgIds].every((o) => okOrgs.has(String(o)));
      res.json({
        ...data, defaultEnd: def, currentMonth: cur, billingReady,
        opening: st.data.opening,
        settings: { ...st.data, version: st.version, updatedBy: st.updatedBy, updatedAt: st.updatedAt },
        orgs: knownOrgs().map((id) => ({ id, name: orgNames()[id] || id })),
        sources,
        syncing: !!running,
        caps: { canEdit, canSync: canEdit },
      });
    } catch (e) {
      console.error('finance kpi:', e.message);
      res.status(500).json({ error: 'load_failed' });
    }
  });

  // Ce qu'il y a derrière les comptes d'un mois (abonnements activés, résiliés, revendeurs, CoO).
  app.get('/api/finance/kpi/detail', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res))) return;
      const m = String(req.query.month || '');
      if (!C.isMonth(m)) return res.status(400).json({ error: 'bad_month' });
      const st = await loadSettings();
      const { facts, detail } = await billingFacts([m], st.data);
      res.json({ month: m, facts: facts[m], detail: detail[m] });
    } catch (e) {
      console.error('finance kpi detail:', e.message);
      res.status(500).json({ error: 'load_failed' });
    }
  });

  // ------------------------------------------------------------------------ budget
  // Cellules du budget KPI. Concurrence optimiste PAR CELLULE (version lue ; 0 = nouvelle).
  // mode 'import' : confirmation d'un import Excel déjà prévisualisé — écrase sans versions.
  app.put('/api/finance/kpi/budget', authenticateToken, async (req, res) => {
    try {
      if (!(await canWrite(req, res))) return;
      const cells = req.body && req.body.cells;
      const imp = req.body && req.body.mode === 'import';
      if (!Array.isArray(cells) || !cells.length || cells.length > 3000) return res.status(400).json({ error: 'bad_cells' });
      for (const c of cells) {
        if (!c || !C.isMonth(c.month) || !KPI_KEYS.includes(c.key)) return res.status(400).json({ error: 'bad_cell', cell: c });
        if (c.value !== null && !finite(c.value)) return res.status(400).json({ error: 'bad_value', cell: c });
      }
      const email = req.user.email;
      const saved = [], conflicts = [];
      for (const c of cells) {
        const v = Number(c.version) || 0;
        let out;
        if (c.value === null) {
          out = imp
            ? await pool.query('DELETE FROM finance_kpi_budget WHERE month = $1::date AND kpi_key = $2 RETURNING 0 AS version', [monthDate(c.month), c.key])
            : await pool.query('DELETE FROM finance_kpi_budget WHERE month = $1::date AND kpi_key = $2 AND version = $3 RETURNING 0 AS version', [monthDate(c.month), c.key, v]);
          if (!out.rows[0] && !imp && v === 0) {
            // Version 0 = « je n'ai rien lu » : correct seulement s'il n'y a rien à effacer.
            const ex = await pool.query('SELECT 1 FROM finance_kpi_budget WHERE month = $1::date AND kpi_key = $2', [monthDate(c.month), c.key]);
            if (!ex.rows[0]) out = { rows: [{ version: 0 }] };
          }
        } else if (imp) {
          out = await pool.query(
            `INSERT INTO finance_kpi_budget (month, kpi_key, value, updated_by) VALUES ($1::date, $2, $3, $4)
             ON CONFLICT (month, kpi_key) DO UPDATE SET value = EXCLUDED.value, version = finance_kpi_budget.version + 1, updated_by = EXCLUDED.updated_by, updated_at = NOW()
             RETURNING version`, [monthDate(c.month), c.key, c.value, email]);
        } else if (v === 0) {
          out = await pool.query(
            `INSERT INTO finance_kpi_budget (month, kpi_key, value, updated_by) VALUES ($1::date, $2, $3, $4)
             ON CONFLICT (month, kpi_key) DO NOTHING RETURNING version`, [monthDate(c.month), c.key, c.value, email]);
        } else {
          out = await pool.query(
            `UPDATE finance_kpi_budget SET value = $3, version = version + 1, updated_by = $4, updated_at = NOW()
              WHERE month = $1::date AND kpi_key = $2 AND version = $5 RETURNING version`, [monthDate(c.month), c.key, c.value, email, v]);
        }
        if (out.rows[0]) { saved.push({ month: c.month, key: c.key, version: out.rows[0].version }); continue; }
        const cur = await pool.query(`SELECT value::float8 AS value, version, updated_by, updated_at FROM finance_kpi_budget WHERE month = $1::date AND kpi_key = $2`, [monthDate(c.month), c.key]);
        conflicts.push({ month: c.month, key: c.key, current: cur.rows[0] ? vOut(cur.rows[0]) : null });
      }
      if (saved.length) {
        if (imp) await logActivity(ENTITY, 'budget', 'imported', `Budget KPI : ${saved.length} cellule(s) importée(s) d'Excel`, email, { metadata: { cells: saved.length } });
        else await throttledLog(`budget|${email}`, ENTITY, 'budget', 'edited', 'Budget KPI modifié', email, { metadata: { cells: saved.length } });
      }
      if (conflicts.length) return res.status(409).json({ error: 'conflict', saved, conflicts });
      res.json({ saved });
    } catch (e) {
      console.error('finance kpi budget:', e.message);
      res.status(500).json({ error: 'save_failed' });
    }
  });

  // ------------------------------------------------------------------------ réels : corrections
  // Une seule porte pour « corriger un réel » :
  //   - ligne alimentée par Books (MRR totale, frais de vente, revenus d'abonnement, Adyen, notes
  //     de crédit) → saisie MANUELLE du grand livre (remplace Books, utile tant que Books n'est
  //     pas reconnecté) ;
  //   - taux USD/CAD → taux manuel (remplace la Banque du Canada) ;
  //   - toute autre ligne → correction du KPI (finance_kpi_actual_override), qui gagne sur le
  //     calcul et se propage aux formules qui en dépendent.
  // value null = retirer la saisie. Toujours journalisé.
  app.put('/api/finance/kpi/actual', authenticateToken, async (req, res) => {
    try {
      if (!(await canWrite(req, res))) return;
      const { month, key, value, note } = req.body || {};
      const version = Number(req.body && req.body.version) || 0;
      if (!C.isMonth(month) || !KPI_KEYS.includes(key)) return res.status(400).json({ error: 'bad_cell' });
      if (value !== null && !finite(value)) return res.status(400).json({ error: 'bad_value' });
      if (note != null && (typeof note !== 'string' || note.length > 500)) return res.status(400).json({ error: 'bad_note' });
      if (key === 'fxUsdCad' && value !== null && (value <= 0 || value > 5)) return res.status(400).json({ error: 'bad_rate' });
      const email = req.user.email;
      let table, where, keyVals, valCol, extra = '';
      if (GL_ROW[key]) { table = 'finance_gl_monthly'; where = "month = $1::date AND line_key = $2 AND source = 'manual'"; keyVals = [monthDate(month), GL_ROW[key]]; valCol = 'amount'; extra = 'line_key, source'; }
      else if (key === 'fxUsdCad') { table = 'finance_fx_monthly'; where = "month = $1::date AND source = 'manual'"; keyVals = [monthDate(month)]; valCol = 'usdcad'; extra = 'source'; }
      else { table = 'finance_kpi_actual_override'; where = 'month = $1::date AND kpi_key = $2'; keyVals = [monthDate(month), key]; valCol = 'value'; extra = 'kpi_key'; }
      const n = keyVals.length;
      let out;
      if (value === null) {
        out = await pool.query(`DELETE FROM ${table} WHERE ${where} AND version = $${n + 1} RETURNING 0 AS version`, [...keyVals, version]);
      } else if (version === 0) {
        const cols = ['month', ...extra.split(', ')];
        const vals = GL_ROW[key] ? [monthDate(month), GL_ROW[key], 'manual'] : key === 'fxUsdCad' ? [monthDate(month), 'manual'] : [monthDate(month), key];
        out = await pool.query(
          `INSERT INTO ${table} (${cols.join(', ')}, ${valCol}, note, updated_by) VALUES (${cols.map((_, i) => (i === 0 ? '$1::date' : `$${i + 1}`)).join(', ')}, $${cols.length + 1}, $${cols.length + 2}, $${cols.length + 3})
           ON CONFLICT DO NOTHING RETURNING version`, [...vals, value, note || null, email]);
      } else {
        out = await pool.query(
          `UPDATE ${table} SET ${valCol} = $${n + 1}, note = $${n + 2}, updated_by = $${n + 3}, version = version + 1, updated_at = NOW()
            WHERE ${where} AND version = $${n + 4} RETURNING version`, [...keyVals, value, note || null, email, version]);
      }
      if (!out.rows[0]) {
        const cur = await pool.query(`SELECT ${valCol}::float8 AS value, note, version, updated_by, updated_at FROM ${table} WHERE ${where}`, keyVals);
        if (value === null && !cur.rows[0]) return res.json({ version: 0, kind: 'none' }); // déjà retiré
        return res.status(409).json({ error: 'conflict', current: cur.rows[0] ? vOut(cur.rows[0]) : null });
      }
      const kind = GL_ROW[key] ? 'gl_manual' : key === 'fxUsdCad' ? 'fx_manual' : 'override';
      await logActivity(ENTITY, `${month}:${key}`, value === null ? `${kind}_cleared` : `${kind}_set`,
        value === null ? `KPI ${key} ${month} : saisie retirée` : `KPI ${key} ${month} : ${value}${note ? ` (${note.slice(0, 120)})` : ''}`,
        email, { metadata: { month, key, value, kind } });
      res.json({ version: out.rows[0].version, kind });
    } catch (e) {
      console.error('finance kpi actual:', e.message);
      res.status(500).json({ error: 'save_failed' });
    }
  });

  // ------------------------------------------------------------------------ réglages
  app.get('/api/finance/kpi/settings', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res))) return;
      const st = await loadSettings();
      res.json({ settings: { ...st.data, version: st.version, updatedBy: st.updatedBy, updatedAt: st.updatedAt }, orgs: knownOrgs().map((id) => ({ id, name: orgNames()[id] || id })) });
    } catch (e) { console.error('finance kpi settings:', e.message); res.status(500).json({ error: 'load_failed' }); }
  });

  app.put('/api/finance/kpi/settings', authenticateToken, async (req, res) => {
    try {
      if (!(await canWrite(req, res))) return;
      const v = validateSettings(req.body && req.body.data, knownOrgs());
      if (typeof v === 'string') return res.status(400).json({ error: v });
      const version = Number(req.body.version) || 0;
      const email = req.user.email;
      const before = await loadSettings();
      const out = version === 0
        ? await pool.query(`INSERT INTO finance_kpi_settings (id, data, version, updated_by) VALUES (1, $1::jsonb, 1, $2) ON CONFLICT (id) DO NOTHING RETURNING version`, [JSON.stringify(v), email])
        : await pool.query(`UPDATE finance_kpi_settings SET data = $1::jsonb, version = version + 1, updated_by = $2, updated_at = NOW() WHERE id = 1 AND version = $3 RETURNING version`, [JSON.stringify(v), email, version]);
      if (!out.rows[0]) { const cur = await loadSettings(); return res.status(409).json({ error: 'conflict', current: { ...cur.data, version: cur.version } }); }
      if (JSON.stringify(before.data.glMapping) !== JSON.stringify(v.glMapping)) await S.recomputeBooksLines(pool, v.glMapping);
      const changed = Object.keys(v).filter((k) => JSON.stringify(before.data[k]) !== JSON.stringify(v[k]));
      await logActivity(ENTITY, 'settings', 'settings_edited', `Réglages KPI modifiés (${changed.join(', ') || 'aucun changement'})`, email, { metadata: { fields: changed } });
      res.json({ version: out.rows[0].version, settings: v });
    } catch (e) { console.error('finance kpi settings save:', e.message); res.status(500).json({ error: 'save_failed' }); }
  });

  // Comptes vus dans les rapports P&L de Books, pour le rattachement. `suggest` n'est qu'une
  // PROPOSITION d'après le nom du compte — rien n'est rattaché sans la CFO.
  const SUGGEST = [
    ['recurringRevenue', /recurring|r[ée]current/i], ['subscriptionRevenue', /subscri|abonnement|saas/i],
    ['adyenIncome', /adyen/i], ['sellingExpense', /selling|sales\s*(&|and)\s*marketing|frais de vente|ventes et marketing/i],
  ];
  app.get('/api/finance/kpi/accounts', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res))) return;
      const r = await pool.query(
        `SELECT account_key, MAX(account_name) AS name, MAX(section) AS section, BOOL_OR(is_group) AS is_group,
                COUNT(*)::int AS months, MAX(month) AS last_month,
                (ARRAY_AGG(amount::float8 ORDER BY month DESC))[1] AS last_amount
           FROM finance_gl_raw GROUP BY account_key ORDER BY MAX(section), MAX(account_name)`);
      res.json({
        accounts: r.rows.map((a) => ({
          key: a.account_key, name: a.name, section: a.section, isGroup: a.is_group, months: a.months, lastAmount: a.last_amount,
          suggest: SUGGEST.filter(([, re]) => re.test(a.name)).map(([line]) => line),
        })),
        lines: GL_MAPPED,
      });
    } catch (e) { console.error('finance kpi accounts:', e.message); res.status(500).json({ error: 'load_failed' }); }
  });

  // ------------------------------------------------------------------------ synchro manuelle
  app.post('/api/finance/kpi/sync', authenticateToken, async (req, res) => {
    try {
      if (!(await canWrite(req, res))) return;
      if (running) return res.status(409).json({ error: 'busy' });
      const every = process.env.FINANCE_KPI_MANUAL_SYNC_MS != null ? Number(process.env.FINANCE_KPI_MANUAL_SYNC_MS) : MANUAL_SYNC_EVERY_MS;
      const wait = every - (Date.now() - lastManual);
      if (wait > 0) return res.status(429).json({ error: 'rate_limited', retryAfterSec: Math.ceil(wait / 1000) });
      lastManual = Date.now();
      await logActivity(ENTITY, 'sync', 'sync_started', 'Synchronisation KPI lancée à la main', req.user.email);
      runSync({ full: true, actor: req.user.email }).catch((e) => console.error('finance kpi sync:', e.message));
      res.status(202).json({ started: true });
    } catch (e) { console.error('finance kpi sync start:', e.message); res.status(500).json({ error: 'sync_failed' }); }
  });

  app.get('/api/finance/kpi/status', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res))) return;
      res.json({ syncing: !!running, sources: await sourcesStatus() });
    } catch (e) { res.status(500).json({ error: 'load_failed' }); }
  });

  // ------------------------------------------------------------------------ Excel
  let xlsx = null;
  try { xlsx = require('xlsx'); } catch { /* sans xlsx : pas de modèle ni d'export */ }
  const sendXlsx = (res, filename, sheets) => {
    const wb = xlsx.utils.book_new();
    for (const s of sheets) {
      const ws = xlsx.utils.aoa_to_sheet(s.rows);
      if (s.cols) ws['!cols'] = s.cols;
      xlsx.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
    }
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  };

  // Modèle du budget KPI : colonne A = clé (ne pas modifier), B = libellé, puis un mois par colonne
  // ('YYYY-MM'), prérempli des valeurs ENREGISTRÉES (pas des valeurs du modèle de drivers).
  app.get('/api/finance/kpi/budget/template', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res))) return;
      if (!xlsx) return res.status(501).json({ error: 'xlsx_unavailable' });
      const end = req.query.end ? String(req.query.end) : C.lastCompleteMonth();
      if (!C.isMonth(end)) return res.status(400).json({ error: 'bad_end' });
      const from = C.addMonths(end, -11);
      const to = C.monthDiff(end, '2027-12') > 0 && C.monthDiff(from, '2027-12') < 36 ? '2027-12' : end;
      const months = C.monthRange(from, to);
      const fr = String(req.query.lang || '').startsWith('fr');
      const b = await pool.query(`SELECT to_char(month, 'YYYY-MM') AS m, kpi_key, value::float8 AS value FROM finance_kpi_budget WHERE month BETWEEN $1::date AND $2::date`, [monthDate(from), monthDate(to)]);
      const by = {};
      for (const r of b.rows) by[`${r.m}|${r.kpi_key}`] = r.value;
      const rows = [['key', fr ? 'KPI' : 'KPI', ...months]];
      for (const k of KPI_KEYS) rows.push([k, LABELS[k][fr ? 1 : 0], ...months.map((m) => (by[`${m}|${k}`] != null ? by[`${m}|${k}`] : null))]);
      sendXlsx(res, `kpi-budget-${from}-${to}.xlsx`, [{ name: 'KPI Budget', rows, cols: [{ wch: 18 }, { wch: 40 }, ...months.map(() => ({ wch: 11 }))] }]);
    } catch (e) { console.error('finance kpi template:', e.message); res.status(500).json({ error: 'export_failed' }); }
  });

  // Lecture d'un import : rien n'est écrit. Renvoie les cellules qui CHANGENT (avec l'ancienne
  // valeur), et les erreurs ligne par ligne. La CFO confirme → PUT /budget mode 'import'.
  const toMonth = (h) => {
    if (h instanceof Date && !isNaN(h)) return `${h.getUTCFullYear()}-${String(h.getUTCMonth() + 1).padStart(2, '0')}`;
    if (typeof h === 'string') {
      const s = h.trim();
      if (C.isMonth(s)) return s;
      const m = /^(\d{4})[/-](\d{1,2})(?:[/-]\d{1,2})?$/.exec(s);
      if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${String(+m[2]).padStart(2, '0')}`;
    }
    return null;
  };
  const toNum = (v) => {
    if (v == null || v === '') return undefined;
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    const s = String(v).replace(/[\s$  ]/g, '').replace(/,(?=\d{1,4}$)/, '.').replace(/,/g, '');
    if (s === '' || s === '-') return undefined;
    return /^-?\d*\.?\d+$/.test(s) ? parseFloat(s) : NaN;
  };
  const uploadMw = (req, res, next) => (kit.upload ? kit.upload(req, res, (err) => (err ? res.status(400).json({ error: 'bad_file' }) : next())) : res.status(501).json({ error: 'upload_unavailable' }));
  app.post('/api/finance/kpi/budget/import', authenticateToken, uploadMw, async (req, res) => {
    try {
      if (!(await canWrite(req, res))) return;
      const wb = kit.readWorkbook(req.file && req.file.buffer);
      if (!wb) return res.status(400).json({ error: 'unreadable' });
      const sheet = wb.sheetNames.includes('KPI Budget') ? 'KPI Budget' : wb.sheetNames[0];
      const rows = wb.rows(sheet);
      const labelToKey = {};
      for (const k of KPI_KEYS) for (const l of LABELS[k]) labelToKey[l.toLowerCase()] = k;
      let hi = -1, keyCol = -1;
      for (let i = 0; i < Math.min(rows.length, 20) && hi < 0; i++) {
        const j = (rows[i] || []).findIndex((c) => typeof c === 'string' && c.trim().toLowerCase() === 'key');
        if (j >= 0) { hi = i; keyCol = j; }
      }
      if (hi < 0) return res.status(400).json({ error: 'no_header' });
      const head = rows[hi];
      const monthCols = [];
      head.forEach((h, j) => { const m = toMonth(h); if (m) monthCols.push({ j, m }); });
      if (!monthCols.length) return res.status(400).json({ error: 'no_months' });
      const errors = [], cells = [];
      const seen = new Set();
      for (let i = hi + 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const rawKey = row[keyCol] != null ? String(row[keyCol]).trim() : '';
        const label = row[keyCol + 1] != null ? String(row[keyCol + 1]).trim().toLowerCase() : '';
        if (!rawKey && !label) continue;
        const key = KPI_KEYS.includes(rawKey) ? rawKey : labelToKey[label];
        if (!key) { errors.push({ row: i + 1, error: 'unknown_kpi', value: rawKey || label }); continue; }
        if (seen.has(key)) { errors.push({ row: i + 1, error: 'duplicate_kpi', value: key }); continue; }
        seen.add(key);
        for (const { j, m } of monthCols) {
          const v = toNum(row[j]);
          if (v === undefined) continue;
          if (!finite(v)) { errors.push({ row: i + 1, month: m, error: 'bad_value', value: String(row[j]).slice(0, 40) }); continue; }
          cells.push({ month: m, key, value: Math.round(v * 10000) / 10000 });
        }
      }
      if (cells.length > 3000) return res.status(400).json({ error: 'too_many_cells' });
      const ms = [...new Set(cells.map((c) => c.month))];
      const old = ms.length ? (await pool.query(`SELECT to_char(month, 'YYYY-MM') AS m, kpi_key, value::float8 AS value FROM finance_kpi_budget WHERE to_char(month, 'YYYY-MM') = ANY($1)`, [ms])).rows : [];
      const ob = Object.fromEntries(old.map((r) => [`${r.m}|${r.kpi_key}`, r.value]));
      const changes = cells.map((c) => ({ ...c, old: ob[`${c.month}|${c.key}`] != null ? ob[`${c.month}|${c.key}`] : null }))
        .filter((c) => c.old === null || Math.abs(c.old - c.value) > 1e-9);
      res.json({ sheet, months: monthCols.map((x) => x.m), cells: changes, unchanged: cells.length - changes.length, errors });
    } catch (e) { console.error('finance kpi import:', e.message); res.status(500).json({ error: 'import_failed' }); }
  });

  // Export XLSX du tableau tel qu'il est affiché (le navigateur envoie les CELLULES ; le serveur
  // n'en fait qu'un classeur, sans rien recalculer).
  app.post('/api/finance/kpi/export', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res))) return;
      if (!xlsx) return res.status(501).json({ error: 'xlsx_unavailable' });
      const rows = req.body && req.body.rows;
      const name = String((req.body && req.body.filename) || 'kpi.xlsx').replace(/[^\w.\-]/g, '_').slice(0, 80);
      const ok = Array.isArray(rows) && rows.length <= 400 && rows.every((r) => Array.isArray(r) && r.length <= 300
        && r.every((c) => c === null || (typeof c === 'string' && c.length <= 300) || finite(c)));
      if (!ok) return res.status(400).json({ error: 'bad_rows' });
      sendXlsx(res, name.endsWith('.xlsx') ? name : `${name}.xlsx`, [{ name: 'KPI', rows, cols: [{ wch: 40 }] }]);
    } catch (e) { console.error('finance kpi export:', e.message); res.status(500).json({ error: 'export_failed' }); }
  });
}

module.exports = { register, ensureSchema, validateSettings, KPI_KEYS, GL_ROW, DEFAULT_SETTINGS, PERM_KPI };
