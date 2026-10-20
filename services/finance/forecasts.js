// ============================================================================
// Module Finance — lot C : Prévision des ventes · BvA, Prévision des paiements, Trésorerie Holdco
// 13 semaines, Investissement en ressources (V2 | Paiements).
//
// Décision de David (2026-10-19) : de VRAIS écrans, aucun chiffre inventé. Les réels viennent de
// ce que Sales Hub sait déjà (forecastsData.js) ; le reste est saisi par la CFO (cellules jaunes)
// ou importé d'Excel (aperçu → confirmation). Les calculs « en direct » (prévision des paiements,
// solde semaine par semaine, seuil de rentabilité) se font dans le navigateur
// (frontend src/pages/Finance/Forecasts/engine.ts) ; le serveur garde les saisies, versionnées
// (concurrence optimiste, comme PUT /api/finance/budgets/:id/state/:section).
//
// 🔑 Salaires : les lignes nominatives de l'investissement (noms, montants par personne) vivent
// dans un document À PART (`people:<programme>`) que seuls les détenteurs de `finance:payroll`
// reçoivent ; les autres reçoivent les totaux par initiative, calculés ici.
//
// Chargé par routes.js (SUBMODULES) : register(app, kit).
// ============================================================================

const { isYm, yearMonths, ymAdd, ymIndex, computeInvestment, r2 } = require('./forecastsCompute');
const { salesActuals, paymentActuals, conversionTeams, booksBankAccounts } = require('./forecastsData');
const IMP = require('./forecastsImport');

const P = {
  view: 'finance:view', edit: 'finance:edit', payroll: 'finance:payroll',
  forecasts: 'finance:forecasts', cash: 'finance:cash', investment: 'finance:investment',
};
const ENTITY = 'finance_forecasts';
const PROGRAMS = ['v2', 'payments'];
const DEFAULT_RESERVE = 1500000;
const MAX_ABS = 1e10;
const SAVE_LOG_EVERY_MS = 15 * 60 * 1000;
const IMPORT_TTL_MS = 60 * 60 * 1000;

// Clé du document → permission du module.
function docPerm(key) {
  if (key === 'sales' || key === 'payments') return P.forecasts;
  if (key === 'cash') return P.cash;
  if (/^inv:(v2|payments)$/.test(key)) return P.investment;
  if (/^people:(v2|payments)$/.test(key)) return P.investment;
  return null;
}
const needsPayroll = (key) => key.startsWith('people:');

// ---------------------------------------------------------------------------- schéma
async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_fc_docs (
      doc_key     TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      version     INT NOT NULL DEFAULT 1,
      updated_by  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_fc_versions (
      id          SERIAL PRIMARY KEY,
      kind        TEXT NOT NULL,
      label       TEXT NOT NULL,
      data        JSONB NOT NULL,
      created_by  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Aperçu d'import en attente de confirmation (le fichier lu et validé, jamais réécrit par le
  // navigateur) ; une heure de vie.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_fc_imports (
      id          SERIAL PRIMARY KEY,
      kind        TEXT NOT NULL,
      payload     JSONB NOT NULL,
      file_name   TEXT,
      created_by  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_at  TIMESTAMPTZ
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS finance_fc_versions_kind ON finance_fc_versions (kind, created_at DESC)');
}

// ---------------------------------------------------------------------------- validation
const finite = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < MAX_ABS;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max, min = 1) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const idStr = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);

function vSales(d) {
  if (!isObj(d)) return 'bad_data';
  const cells = d.cells || {};
  if (!isObj(cells)) return 'bad_cells';
  const out = {};
  let n = 0;
  for (const [s, byYm] of Object.entries(cells)) {
    if (!IMP.SALES_SERIES.includes(s)) return `unknown_series:${s}`;
    if (!isObj(byYm)) return 'bad_cells';
    out[s] = {};
    for (const [k, c] of Object.entries(byYm)) {
      if (!isYm(k) || !isObj(c)) return 'bad_month';
      const o = {};
      for (const [f, v] of Object.entries(c)) {
        if (!IMP.SALES_FIELDS.includes(f)) return `unknown_field:${f}`;
        if (v === null) continue;
        if (!finite(v)) return `bad_value:${f}`;
        if (f !== 'mrr' && v < 0) return `negative:${f}`;
        o[f] = v;
      }
      if (Object.keys(o).length) { out[s][k] = o; n++; }
    }
  }
  if (n > 2000) return 'too_many_cells';
  return { cells: out };
}

const PAY_RANGE = { inst: [0, 1e6], conv: [0, 1e6], churn: [0, 100], arpuG: [-100, 100], margin: [0, 100] };
function vPayments(d) {
  if (!isObj(d)) return 'bad_data';
  const out = { assumptions: {}, overrides: {}, convTeamIds: null, compareVersionId: null };
  const a = d.assumptions || {};
  if (!isObj(a)) return 'bad_assumptions';
  for (const [k, v] of Object.entries(a)) {
    if (!PAY_RANGE[k]) return `unknown_assumption:${k}`;
    if (v === null) continue;
    if (!finite(v) || v < PAY_RANGE[k][0] || v > PAY_RANGE[k][1]) return `bad_assumption:${k}`;
    out.assumptions[k] = v;
  }
  const ov = d.overrides || {};
  if (!isObj(ov)) return 'bad_overrides';
  if (Object.keys(ov).length > 240) return 'too_many_overrides';
  for (const [k, o] of Object.entries(ov)) {
    if (!isYm(k) || !isObj(o)) return 'bad_month';
    const x = {};
    for (const [f, v] of Object.entries(o)) {
      if (!IMP.PAY_FIELDS.includes(f)) return `unknown_field:${f}`;
      if (v === null) continue;
      if (!finite(v) || v < 0) return `bad_value:${f}`;
      x[f] = v;
    }
    if (Object.keys(x).length) out.overrides[k] = x;
  }
  if (d.convTeamIds != null) {
    if (!Array.isArray(d.convTeamIds) || d.convTeamIds.length > 50 || !d.convTeamIds.every((x) => Number.isInteger(x) && x > 0)) return 'bad_teams';
    out.convTeamIds = d.convTeamIds;
  }
  if (d.compareVersionId != null) {
    if (!Number.isInteger(d.compareVersionId) || d.compareVersionId <= 0) return 'bad_version';
    out.compareVersionId = d.compareVersionId;
  }
  return out;
}

const ADJ_CATS = [...IMP.CASH_CATS, 'allIn', 'allOut'];
function vAdj(a) {
  if (!isObj(a) || !idStr(a.id) || !str(a.label, 120) || !ADJ_CATS.includes(a.category) || !['pct', 'amount'].includes(a.mode) || !finite(a.value)) return false;
  if (a.mode === 'pct' && Math.abs(a.value) > 1000) return false;
  if (!Number.isInteger(a.from) || !Number.isInteger(a.to) || a.from < 1 || a.to > IMP.WEEKS || a.to < a.from) return false;
  return true;
}
function vCash(d) {
  if (!isObj(d)) return 'bad_data';
  const out = {};
  if (typeof d.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.startDate)) return 'bad_start';
  const sd = new Date(`${d.startDate}T12:00:00Z`);
  if (Number.isNaN(sd.getTime()) || sd.toISOString().slice(0, 10) !== d.startDate) return 'bad_start';
  if (sd.getUTCDay() !== 1) return 'not_monday';
  out.startDate = d.startDate;
  const o = d.opening || {};
  if (!isObj(o) || !['manual', 'books'].includes(o.mode)) return 'bad_opening';
  if (o.amount != null && !finite(o.amount)) return 'bad_opening';
  out.opening = { mode: o.mode, amount: o.amount == null ? null : o.amount };
  if (o.mode === 'books') {
    if (!Array.isArray(o.accountIds) || o.accountIds.length > 50 || !o.accountIds.every((x) => typeof x === 'string' && x.length <= 40)) return 'bad_accounts';
    if (o.at != null && (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at)))) return 'bad_opening';
    out.opening.accountIds = o.accountIds;
    out.opening.at = o.at || null;
  }
  if (!finite(d.reserve) || d.reserve < 0) return 'bad_reserve';
  out.reserve = d.reserve;
  const lines = d.lines || {};
  if (!isObj(lines)) return 'bad_lines';
  out.lines = {};
  for (const [k, a] of Object.entries(lines)) {
    if (!IMP.CASH_CATS.includes(k)) return `unknown_category:${k}`;
    if (!Array.isArray(a) || a.length !== IMP.WEEKS) return `bad_line:${k}`;
    for (const v of a) {
      if (v === null) continue;
      if (!finite(v)) return `bad_line:${k}`;
      if (k !== 'interco' && v < 0) return `negative:${k}`;
    }
    out.lines[k] = a;
  }
  const sc = d.scenarios || {};
  if (!isObj(sc)) return 'bad_scenarios';
  out.scenarios = { down: [], up: [] };
  for (const s of ['down', 'up']) {
    const list = sc[s] || [];
    if (!Array.isArray(list) || list.length > 30) return 'bad_scenarios';
    for (const a of list) if (!vAdj(a)) return 'bad_adjustment';
    out.scenarios[s] = list.map((a) => ({ id: a.id, label: a.label.trim(), category: a.category, mode: a.mode, value: a.value, from: a.from, to: a.to }));
  }
  return out;
}

function vMonths(months) {
  if (!Array.isArray(months) || months.length > 60 || !months.every(isYm)) return false;
  for (let i = 1; i < months.length; i++) if (ymIndex(months[i]) !== ymIndex(months[i - 1]) + 1) return false;
  return true;
}
const vSeries = (o, months) => isObj(o) && Object.entries(o).every(([k, v]) => months.includes(k) && finite(v));

function vInv(d, prev) {
  if (!isObj(d)) return 'bad_data';
  if (!vMonths(d.months || [])) return 'bad_months';
  const months = d.months || [];
  const inits = d.initiatives || [];
  if (!Array.isArray(inits) || inits.length > 60) return 'bad_initiatives';
  const ids = new Set();
  const out = { months, initiatives: [], returns: {}, returnLabel: null, source: (prev && prev.source) || null };
  for (const it of inits) {
    if (!isObj(it) || !idStr(it.id) || ids.has(it.id) || !str(it.name, 120)) return 'bad_initiative';
    if (it.capPct != null && (!finite(it.capPct) || it.capPct < 0 || it.capPct > 100)) return 'bad_cap';
    const other = it.other || {};
    if (!vSeries(other, months)) return 'bad_other';
    if (Object.values(other).some((v) => v < 0)) return 'bad_other';
    ids.add(it.id);
    out.initiatives.push({ id: it.id, name: it.name.trim(), capPct: it.capPct == null ? null : it.capPct, other });
  }
  const ret = d.returns || {};
  if (!vSeries(ret, months)) return 'bad_returns';
  out.returns = ret;
  if (d.returnLabel != null) { if (typeof d.returnLabel !== 'string' || d.returnLabel.length > 120) return 'bad_label'; out.returnLabel = d.returnLabel.trim() || null; }
  return out;
}

function vPeople(d, months) {
  if (!isObj(d) || !Array.isArray(d.people) || d.people.length > 300) return 'bad_people';
  const ids = new Set();
  const people = [];
  for (const p of d.people) {
    if (!isObj(p) || !idStr(p.id) || ids.has(p.id)) return 'bad_person';
    if (!['Employee', 'Contractor'].includes(p.type) || !str(p.name, 120) || typeof p.map !== 'string' || p.map.length > 60) return 'bad_person';
    if (p.base != null && !finite(p.base)) return 'bad_person';
    if (p.initiativeId != null && !idStr(p.initiativeId)) return 'bad_person';
    if (!finite(p.alloc) || p.alloc < 0 || p.alloc > 100) return 'bad_alloc';
    if (!vSeries(p.monthly || {}, months) || Object.values(p.monthly || {}).some((v) => v < 0)) return 'bad_monthly';
    ids.add(p.id);
    people.push({ id: p.id, type: p.type, name: p.name.trim(), map: p.map, base: p.base == null ? null : p.base, monthly: p.monthly || {}, initiativeId: p.initiativeId || null, alloc: p.alloc });
  }
  return { people };
}

// ---------------------------------------------------------------------------- défauts
// Lundi de la semaine en cours, à Montréal.
function mondayToday(now = new Date()) {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const d = new Date(`${s}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}
function todayYm(now = new Date()) {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return { ym: s.slice(0, 7), day: Number(s.slice(8, 10)), date: s };
}
const DEFAULTS = {
  sales: () => ({ cells: {} }),
  payments: () => ({ assumptions: {}, overrides: {}, convTeamIds: null, compareVersionId: null }),
  cash: () => ({ startDate: mondayToday(), opening: { mode: 'manual', amount: null }, reserve: DEFAULT_RESERVE, lines: {}, scenarios: { down: [], up: [] } }),
  inv: () => ({ months: [], initiatives: [], returns: {}, returnLabel: null, source: null }),
  people: () => ({ people: [] }),
};
const defaultFor = (key) => DEFAULTS[key.split(':')[0]]();

// ---------------------------------------------------------------------------- register
function register(app, kit) {
  const { pool, authenticateToken, logActivity } = kit;
  let ready = null;
  const schema = () => (ready = ready || (async () => { await kit.schema(); await ensureSchema(pool); })().catch((e) => { ready = null; throw e; }));
  if (pool) schema().catch((e) => console.error('finance forecasts schema:', e.message));
  let http = null;
  try { http = require('axios'); } catch { /* bancs d'essai */ }
  const lastLog = new Map();

  // Lecture : finance:view + la permission du module. Écriture : + finance:edit (+ payroll).
  const canRead = async (req, res, perm) => { if (!(await kit.guardAll(req, res, [P.view, perm]))) return false; await schema(); return true; };
  const canWrite = async (req, res, perm, payroll) => {
    if (!(await kit.guardAll(req, res, [P.view, perm, P.edit, ...(payroll ? [P.payroll] : [])]))) return false;
    await schema(); return true;
  };
  const caps = async (req, perm) => {
    const edit = (await kit.can(req, perm)) && (await kit.can(req, P.edit));
    const payroll = await kit.can(req, P.payroll);
    return { canEdit: edit, canPayroll: payroll, canEditPayroll: edit && payroll };
  };

  async function readDoc(key) {
    const r = await pool.query('SELECT data, version, updated_by, updated_at FROM finance_fc_docs WHERE doc_key = $1', [key]);
    const d = r.rows[0];
    return d ? { data: d.data, version: d.version, updatedBy: d.updated_by, updatedAt: d.updated_at } : { data: defaultFor(key), version: 0, updatedBy: null, updatedAt: null };
  }

  // Écriture versionnée : version lue → 409 `conflict` + version courante si quelqu'un est passé avant.
  async function writeDoc(key, data, version, email) {
    let out;
    if (!version) {
      out = await pool.query(
        `INSERT INTO finance_fc_docs (doc_key, data, version, updated_by) VALUES ($1, $2::jsonb, 1, $3)
         ON CONFLICT (doc_key) DO NOTHING RETURNING version`, [key, JSON.stringify(data), email]);
    } else {
      out = await pool.query(
        `UPDATE finance_fc_docs SET data = $2::jsonb, version = version + 1, updated_by = $3, updated_at = NOW()
          WHERE doc_key = $1 AND version = $4 RETURNING version`, [key, JSON.stringify(data), email, version]);
    }
    if (out.rows[0]) return { version: out.rows[0].version };
    return { conflict: await readDoc(key) };
  }

  const throttledLog = async (key, email, desc, meta) => {
    const k = `${key}|${email}`;
    const now = Date.now();
    if (lastLog.has(k) && now - lastLog.get(k) < SAVE_LOG_EVERY_MS) return;
    lastLog.set(k, now);
    await logActivity(ENTITY, key, 'edited', desc, email, { metadata: meta });
  };

  function validate(key, data, prev, months) {
    if (key === 'sales') return vSales(data);
    if (key === 'payments') return vPayments(data);
    if (key === 'cash') return vCash(data);
    if (key.startsWith('inv:')) return vInv(data, prev);
    if (key.startsWith('people:')) return vPeople(data, months);
    return 'unknown_doc';
  }

  const LABELS = { sales: 'Prévision des ventes', payments: 'Prévision des paiements', cash: 'Trésorerie Holdco', 'inv:v2': 'Investissement V2', 'inv:payments': 'Investissement Paiements', 'people:v2': 'Effectif V2', 'people:payments': 'Effectif Paiements' };

  // ------------------------------------------------------------------------ PUT document
  app.put('/api/finance/forecasts/docs/:key', authenticateToken, async (req, res) => {
    try {
      const key = req.params.key;
      const perm = docPerm(key);
      if (!perm) return res.status(400).json({ error: 'unknown_doc' });
      if (!(await canWrite(req, res, perm, needsPayroll(key)))) return;
      const cur = await readDoc(key);
      let months = null;
      if (key.startsWith('people:')) months = (await readDoc(`inv:${key.slice(7)}`)).data.months || [];
      const v = validate(key, req.body && req.body.data, cur.data, months);
      if (typeof v === 'string') return res.status(400).json({ error: v });
      const w = await writeDoc(key, v, Number(req.body.version) || 0, req.user.email);
      if (w.conflict) return res.status(409).json({ error: 'conflict', current: w.conflict });
      await throttledLog(key, req.user.email, `${LABELS[key]} : saisie modifiée`, { doc: key });
      res.json({ version: w.version, data: v });
    } catch (e) {
      console.error('finance forecasts save:', e.message);
      res.status(500).json({ error: 'save_failed' });
    }
  });

  // ------------------------------------------------------------------------ ventes
  app.get('/api/finance/forecasts/sales', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res, P.forecasts))) return;
      const today = todayYm();
      const year = Number(req.query.year) || Number(today.ym.slice(0, 4));
      if (year < 2015 || year > 2100) return res.status(400).json({ error: 'bad_year' });
      const [actual, prior, doc] = await Promise.all([salesActuals(pool, year), salesActuals(pool, year - 1), readDoc('sales')]);
      res.json({ year, today, actual, prior, doc, caps: await caps(req, P.forecasts) });
    } catch (e) {
      console.error('finance forecasts sales:', e.message);
      res.status(500).json({ error: 'load_failed' });
    }
  });

  // ------------------------------------------------------------------------ paiements
  app.get('/api/finance/forecasts/payments', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res, P.forecasts))) return;
      const today = todayYm();
      const year = Number(req.query.year) || Number(today.ym.slice(0, 4));
      if (year < 2015 || year > 2100) return res.status(400).json({ error: 'bad_year' });
      const doc = await readDoc('payments');
      const teams = await conversionTeams(pool);
      // Année précédente (colonne FY-1) + l'année affichée ; le dernier réel peut être plus tôt.
      const actual = await paymentActuals(pool, `${year - 1}-01`, `${year}-12`, doc.data.convTeamIds);
      // Graine de la prévision : le dernier mois réel connu, même s'il précède l'année affichée.
      let seed = null;
      if (actual.lastActual && actual.lastActual < `${year - 1}-01`) {
        const s = await paymentActuals(pool, ymAdd(actual.lastActual, -3), actual.lastActual, doc.data.convTeamIds);
        seed = s.months;
      }
      // Versions enregistrées, avec leurs séries (petites : ≤ 24 mois) : la comparaison se choisit
      // dans la page sans nouvel appel.
      const versions = (await pool.query("SELECT id, label, data, created_by, created_at FROM finance_fc_versions WHERE kind = 'payments' ORDER BY created_at DESC LIMIT 50")).rows
        .map((v) => ({ id: v.id, label: v.label, createdBy: v.created_by, createdAt: v.created_at, data: v.data }));
      res.json({ year, today, actual, seed, doc, teams, versions, caps: await caps(req, P.forecasts) });
    } catch (e) {
      console.error('finance forecasts payments:', e.message);
      res.status(500).json({ error: 'load_failed' });
    }
  });

  // Enregistrer la prévision courante comme version nommée (remplace le toast « Save scenario »).
  app.post('/api/finance/forecasts/payments/versions', authenticateToken, async (req, res) => {
    try {
      if (!(await canWrite(req, res, P.forecasts))) return;
      const b = req.body || {};
      if (!str(b.label, 80)) return res.status(400).json({ error: 'bad_label' });
      const series = b.series;
      if (!isObj(series) || Object.keys(series).length > 60) return res.status(400).json({ error: 'bad_series' });
      for (const [k, o] of Object.entries(series)) {
        if (!isYm(k) || !isObj(o)) return res.status(400).json({ error: 'bad_series' });
        for (const [f, v] of Object.entries(o)) if (!IMP.PAY_FIELDS.includes(f) || !(v === null || finite(v))) return res.status(400).json({ error: 'bad_series' });
      }
      const a = vPayments({ assumptions: b.assumptions || {} });
      if (typeof a === 'string') return res.status(400).json({ error: a });
      const r = await pool.query(
        "INSERT INTO finance_fc_versions (kind, label, data, created_by) VALUES ('payments', $1, $2::jsonb, $3) RETURNING id, label, created_by, created_at",
        [b.label.trim(), JSON.stringify({ series, assumptions: a.assumptions }), req.user.email]);
      const v = r.rows[0];
      await logActivity(ENTITY, 'payments', 'version_saved', `Prévision des paiements : version « ${v.label} » enregistrée`, req.user.email, { metadata: { versionId: v.id } });
      res.json({ version: { id: v.id, label: v.label, createdBy: v.created_by, createdAt: v.created_at } });
    } catch (e) {
      console.error('finance forecasts version:', e.message);
      res.status(500).json({ error: 'save_failed' });
    }
  });

  // ------------------------------------------------------------------------ trésorerie
  app.get('/api/finance/forecasts/cash', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res, P.cash))) return;
      res.json({ today: todayYm(), doc: await readDoc('cash'), defaultReserve: DEFAULT_RESERVE, caps: await caps(req, P.cash) });
    } catch (e) {
      console.error('finance forecasts cash:', e.message);
      res.status(500).json({ error: 'load_failed' });
    }
  });

  // Comptes bancaires Zoho Books, lus à la demande (bouton). Sans banking.READ : « reconnecter ».
  app.get('/api/finance/forecasts/cash/bank-accounts', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res, P.cash))) return;
      const late = kit.late();
      const out = await booksBankAccounts(late, register._http || http);
      res.json(out);
    } catch (e) {
      console.error('finance forecasts bank accounts:', e.message);
      res.json({ status: 'error' });
    }
  });

  // ------------------------------------------------------------------------ investissement
  async function investmentPayload(req, program) {
    const inv = await readDoc(`inv:${program}`);
    const ppl = await readDoc(`people:${program}`);
    const c = await caps(req, P.investment);
    const computed = computeInvestment(inv.data, ppl.data.people);
    const body = { program, today: todayYm(), doc: inv, computed, caps: c };
    if (c.canPayroll) body.people = ppl;
    return body;
  }
  app.get('/api/finance/forecasts/investment', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res, P.investment))) return;
      const program = String(req.query.program || 'v2');
      if (!PROGRAMS.includes(program)) return res.status(400).json({ error: 'bad_program' });
      res.json(await investmentPayload(req, program));
    } catch (e) {
      console.error('finance forecasts investment:', e.message);
      res.status(500).json({ error: 'load_failed' });
    }
  });

  // ------------------------------------------------------------------------ modèles Excel
  app.get('/api/finance/forecasts/template/:kind', authenticateToken, async (req, res) => {
    try {
      const kind = req.params.kind;
      const perm = kind === 'cash' ? P.cash : kind === 'investment' ? P.investment : (kind === 'sales' || kind === 'payments') ? P.forecasts : null;
      if (!perm) return res.status(400).json({ error: 'unknown_kind' });
      if (!(await canRead(req, res, perm))) return;
      const today = todayYm();
      let buf, name;
      if (kind === 'sales') {
        const year = Number(req.query.year) || Number(today.ym.slice(0, 4));
        buf = IMP.salesTemplate(year, (await readDoc('sales')).data); name = `sales-forecast-${year}.xlsx`;
      } else if (kind === 'payments') {
        const year = Number(req.query.year) || Number(today.ym.slice(0, 4));
        buf = IMP.paymentsTemplate((await readDoc('payments')).data, `${year}-01`, `${year}-12`); name = `payments-forecast-${year}.xlsx`;
      } else if (kind === 'cash') {
        buf = IMP.cashTemplate((await readDoc('cash')).data); name = 'holdco-cash-13-weeks.xlsx';
      } else {
        const inv = (await readDoc('inv:v2')).data;
        const months = inv.months && inv.months.length ? inv.months : Array.from({ length: 16 }, (_, i) => ymAdd(today.ym, i));
        buf = IMP.investmentTemplate(months); name = 'resource-investment.xlsx';
      }
      if (!buf) return res.status(500).json({ error: 'xlsx_unavailable' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.send(buf);
    } catch (e) {
      console.error('finance forecasts template:', e.message);
      res.status(500).json({ error: 'template_failed' });
    }
  });

  // ------------------------------------------------------------------------ import : aperçu
  const KIND_PERM = { sales: P.forecasts, payments: P.forecasts, cash: P.cash, investment: P.investment };
  const runUpload = (req, res) => new Promise((ok) => {
    if (!kit.upload) { res.status(500).json({ error: 'upload_unavailable' }); return ok(false); }
    kit.upload(req, res, (err) => {
      if (err) { res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'bad_upload' }); return ok(false); }
      ok(true);
    });
  });

  app.post('/api/finance/forecasts/import/:kind/preview', authenticateToken, async (req, res) => {
    try {
      const kind = req.params.kind;
      if (!KIND_PERM[kind]) return res.status(400).json({ error: 'unknown_kind' });
      // L'effectif nominatif s'importe avec l'investissement : finance:payroll exigée.
      if (!(await canWrite(req, res, KIND_PERM[kind], kind === 'investment'))) return;
      if (!(await runUpload(req, res))) return;
      if (!req.file) return res.status(400).json({ error: 'no_file' });
      const wb = kit.readWorkbook(req.file.buffer);
      if (!wb) return res.status(400).json({ error: 'unreadable_file' });
      const parsed = kind === 'sales' ? IMP.parseSales(wb) : kind === 'payments' ? IMP.parsePayments(wb) : kind === 'cash' ? IMP.parseCash(wb) : IMP.parseInvestment(wb);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const summary = await previewSummary(kind, parsed);
      const fileName = String(req.file.originalname || '').slice(0, 200);
      const r = await pool.query(
        'INSERT INTO finance_fc_imports (kind, payload, file_name, created_by) VALUES ($1, $2::jsonb, $3, $4) RETURNING id',
        [kind, JSON.stringify(parsed), fileName, req.user.email]);
      res.json({ importId: r.rows[0].id, kind, fileName, summary });
    } catch (e) {
      console.error('finance forecasts import preview:', e.message);
      res.status(500).json({ error: 'import_failed' });
    }
  });

  // Ce que l'import changerait, en clair (sans rien écrire).
  async function previewSummary(kind, p) {
    if (kind === 'sales') {
      const cur = (await readDoc('sales')).data.cells || {};
      const bySeries = {};
      let changed = 0;
      for (const c of p.cells) {
        bySeries[c.series] = (bySeries[c.series] || 0) + 1;
        const old = cur[c.series] && cur[c.series][c.ym] && cur[c.series][c.ym][c.field];
        if (old !== c.value) changed++;
      }
      const months = [...new Set(p.cells.map((c) => c.ym))].sort();
      return { cells: p.cells.length, changed, bySeries, from: months[0] || null, to: months[months.length - 1] || null, errors: p.errors, sample: p.cells.slice(0, 40) };
    }
    if (kind === 'payments') {
      return { assumptions: p.assumptions, overrideMonths: Object.keys(p.overrides).sort(), overrides: p.overrides, errors: p.errors };
    }
    if (kind === 'cash') {
      const totals = Object.fromEntries(Object.entries(p.lines).map(([k, a]) => [k, r2(a.reduce((s, v) => s + (v || 0), 0))]));
      return { startDate: p.startDate || null, opening: p.opening ?? null, reserve: p.reserve ?? null, categories: Object.keys(p.lines), totals, lines: p.lines, errors: p.errors };
    }
    const out = {};
    for (const [prog, x] of Object.entries(p.programs)) {
      if (x.error) { out[prog] = { sheet: x.sheet, error: x.error }; continue; }
      // Arrondi au cent à la FIN seulement (arrondir à chaque mois déplace le total de 2 cents).
      const byYear = {}, retByYear = {};
      for (const k of x.months) {
        const y = k.slice(0, 4);
        byYear[y] = (byYear[y] || 0) + x.people.reduce((s, pp) => s + pp.monthly[k], 0);
        if (x.returns) retByYear[y] = (retByYear[y] || 0) + x.returns[k];
      }
      for (const o of [byYear, retByYear]) for (const y of Object.keys(o)) o[y] = r2(o[y]);
      out[prog] = {
        sheet: x.sheet, from: x.months[0], to: x.months[x.months.length - 1], months: x.months.length,
        employees: x.people.filter((pp) => pp.type === 'Employee').length, contractors: x.people.filter((pp) => pp.type === 'Contractor').length,
        costByYear: byYear, returnByYear: x.returns ? retByYear : null, returnLabel: x.returnLabel, warnings: x.warnings,
      };
    }
    return { programs: out };
  }

  // ------------------------------------------------------------------------ import : confirmation
  app.post('/api/finance/forecasts/import/:id/confirm', authenticateToken, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad_id' });
      await schema();
      const r = await pool.query('SELECT * FROM finance_fc_imports WHERE id = $1', [id]);
      const imp = r.rows[0];
      if (!imp) return res.status(404).json({ error: 'not_found' });
      if (!(await canWrite(req, res, KIND_PERM[imp.kind], imp.kind === 'investment'))) return;
      if (imp.created_by !== req.user.email) return res.status(403).json({ error: 'not_yours' });
      if (imp.applied_at) return res.status(409).json({ error: 'already_applied' });
      if (Date.now() - new Date(imp.created_at).getTime() > IMPORT_TTL_MS) return res.status(410).json({ error: 'expired' });
      const versions = (req.body && req.body.versions) || {};
      const plan = await applyPlan(imp.kind, imp.payload, imp.file_name, req.user.email);
      // Concurrence : chaque document doit être encore à la version que la CFO a lue.
      for (const w of plan) {
        const cur = await readDoc(w.key);
        if ((Number(versions[w.key]) || 0) !== cur.version) return res.status(409).json({ error: 'conflict', key: w.key, current: cur });
      }
      const claimed = await pool.query('UPDATE finance_fc_imports SET applied_at = NOW() WHERE id = $1 AND applied_at IS NULL RETURNING id', [id]);
      if (!claimed.rows[0]) return res.status(409).json({ error: 'already_applied' });
      const written = {};
      for (const w of plan) {
        const out = await writeDoc(w.key, w.data, Number(versions[w.key]) || 0, req.user.email);
        if (out.conflict) {
          await pool.query('UPDATE finance_fc_imports SET applied_at = NULL WHERE id = $1', [id]);
          return res.status(409).json({ error: 'conflict', key: w.key, current: out.conflict, written });
        }
        written[w.key] = out.version;
      }
      await logActivity(ENTITY, plan.map((w) => w.key).join(','), 'imported', `Import Excel (${imp.kind}) appliqué : ${imp.file_name || 'fichier'}`, req.user.email, { metadata: { importId: id, docs: Object.keys(written) } });
      res.json({ ok: true, versions: written });
    } catch (e) {
      if (/^import_invalid:/.test(e.message)) return res.status(400).json({ error: e.message });
      console.error('finance forecasts import confirm:', e.message);
      res.status(500).json({ error: 'import_failed' });
    }
  });

  // Les documents à écrire pour un import (fusion avec l'état courant). Validés comme une saisie.
  async function applyPlan(kind, p, fileName, email) {
    const plan = [];
    const push = (key, data, prev, months) => {
      const v = validate(key, data, prev, months);
      if (typeof v === 'string') { const e = new Error(`import_invalid:${v}`); throw e; }
      plan.push({ key, data: v });
    };
    if (kind === 'sales') {
      const cur = (await readDoc('sales')).data;
      const cells = JSON.parse(JSON.stringify(cur.cells || {}));
      for (const c of p.cells) ((cells[c.series] = cells[c.series] || {})[c.ym] = cells[c.series][c.ym] || {})[c.field] = c.value;
      push('sales', { cells });
    } else if (kind === 'payments') {
      const cur = (await readDoc('payments')).data;
      const overrides = JSON.parse(JSON.stringify(cur.overrides || {}));
      for (const [k, o] of Object.entries(p.overrides)) overrides[k] = { ...(overrides[k] || {}), ...o };
      push('payments', { ...cur, assumptions: { ...(cur.assumptions || {}), ...p.assumptions }, overrides });
    } else if (kind === 'cash') {
      const cur = (await readDoc('cash')).data;
      const lines = { ...(cur.lines || {}) };
      for (const [k, a] of Object.entries(p.lines)) {
        const old = lines[k] || Array(IMP.WEEKS).fill(null);
        lines[k] = a.map((v, i) => (v == null ? old[i] : v));
      }
      push('cash', {
        ...cur,
        startDate: p.startDate || cur.startDate,
        opening: p.opening != null ? { mode: 'manual', amount: p.opening } : cur.opening,
        reserve: p.reserve != null ? p.reserve : cur.reserve,
        lines,
      });
    } else {
      for (const [prog, x] of Object.entries(p.programs)) {
        if (x.error) continue;
        const inv = (await readDoc(`inv:${prog}`)).data;
        const old = (await readDoc(`people:${prog}`)).data.people || [];
        let initiatives = (inv.initiatives || []).map((it) => ({ ...it, other: Object.fromEntries(Object.entries(it.other || {}).filter(([k]) => x.months.includes(k))) }));
        // Première importation : une initiative, du nom de la feuille. La CFO la scinde ensuite.
        if (!initiatives.length) initiatives = [{ id: 'main', name: x.sheet === 'V2' ? 'Kaizen V2' : x.sheet, capPct: null, other: {} }];
        const firstId = initiatives[0].id;
        // Une personne déjà là (même type, même nom) garde son initiative et son allocation.
        const keyOf = (pp) => `${pp.type}|${pp.name.toLowerCase()}`;
        const prev = new Map(old.map((pp) => [keyOf(pp), pp]));
        const people = x.people.map((pp, i) => {
          const o = prev.get(keyOf(pp));
          return { id: o ? o.id : `p${Date.now().toString(36)}${i}`, type: pp.type, name: pp.name, map: pp.map, base: pp.base, monthly: pp.monthly, initiativeId: o ? o.initiativeId : firstId, alloc: o ? o.alloc : 100 };
        });
        const returns = x.returns ? x.returns : Object.fromEntries(Object.entries(inv.returns || {}).filter(([k]) => x.months.includes(k)));
        const invNext = { months: x.months, initiatives, returns, returnLabel: x.returns ? x.returnLabel : inv.returnLabel || null };
        const v = vInv(invNext, null);
        if (typeof v === 'string') throw new Error(`import_invalid:${v}`);
        v.source = { sheet: x.sheet, file: fileName || null, importedAt: new Date().toISOString(), importedBy: email };
        plan.push({ key: `inv:${prog}`, data: v });
        push(`people:${prog}`, { people }, null, x.months);
      }
      if (!plan.length) throw new Error('import_invalid:nothing_to_import');
    }
    return plan;
  }
}

// Le banc d'essai remplace le client HTTP de Zoho (register._http).
module.exports = { register, ensureSchema, vSales, vPayments, vCash, vInv, vPeople, mondayToday, todayYm, yearMonths };
