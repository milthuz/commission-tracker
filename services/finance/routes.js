// ============================================================================
// Module Finance (CFO) — couche HTTP. Phase 1 : Budget maître consolidé FY2027, Drivers de
// revenus, Drivers de COGS, Salaires & contractuels, OPEX.
//
// Remplace les classeurs Excel de la CFO par un budget vivant. Les CALCULS se font dans le
// navigateur (frontend src/pages/Finance/model.ts), à chaque frappe, comme le prototype du
// design (design/finance). Le serveur garde :
//   - la RÉFÉRENCE du budget (valeurs par défaut des drivers, soldes de départ, colonne 2026,
//     lignes OPEX de base, éléments hors exploitation) — importée une fois depuis les données
//     de la CFO (import.js), jamais dans le code : le frontend est public sur Netlify ;
//   - les AJUSTEMENTS de la CFO, par section (drivers, opex, voyages, réglages de paie) ;
//   - l'EFFECTIF (employés et contractuels), ligne par ligne, avec de vrais identifiants ;
//   - le STATUT : un budget approuvé est VERROUILLÉ — le serveur refuse toute écriture
//     jusqu'à ce qu'un détenteur de `finance:approve` le déverrouille (décision de David,
//     2026-10-19 ; le prototype ne changeait que l'étiquette).
//
// 🔑 Salaires : seuls les détenteurs de `finance:payroll` reçoivent les noms et montants
// individuels. Les autres usagers de la section reçoivent les totaux mensuels par poste,
// calculés ici (payroll.js) — garder ce calcul identique à celui du navigateur.
//
// Monté par UNE ligne dans server.js, comme services/revenueModel.
// ============================================================================

const { MAPS, payrollAggregate } = require('./payroll');

const PERM_VIEW = 'finance:view';
const PERM_EDIT = 'finance:edit';
const PERM_PAYROLL = 'finance:payroll';
const PERM_APPROVE = 'finance:approve';

const SECTIONS = ['drivers', 'opex', 'trips', 'payroll'];
const ENTITIES = ['Cluster', 'Xperio'];
const TRIP_DEPTS = ['S&M', 'R&D', 'G&A'];
const TRAVEL_KEYS = ['smTravel', 'rdTravel', 'gaTravel'];
const DEFAULT_PAYROLL = { burden: 17.5, raise: 0, raiseMo: 0 };
const MAX_ABS = 1e10;
// Une trace au journal par usager et par section toutes les 15 min au plus : l'enregistrement
// automatique écrit à chaque pause de frappe, le journal n'a pas à en garder chaque frappe.
const SAVE_LOG_EVERY_MS = 15 * 60 * 1000;

async function ensureSchema(pool) {
  // Une instruction par appel : PGlite (bancs d'essai) refuse les lots.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_budgets (
      id           SERIAL PRIMARY KEY,
      fiscal_year  INT NOT NULL,
      entity       TEXT NOT NULL DEFAULT 'consolidated',
      status       TEXT NOT NULL DEFAULT 'draft',
      approved_by  TEXT,
      approved_at  TIMESTAMPTZ,
      reference    JSONB NOT NULL,
      imported_by  TEXT,
      imported_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (fiscal_year, entity)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_state (
      budget_id   INT NOT NULL REFERENCES finance_budgets(id) ON DELETE CASCADE,
      section     TEXT NOT NULL,
      data        JSONB NOT NULL,
      version     INT NOT NULL DEFAULT 1,
      updated_by  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (budget_id, section)
    )`);
  // salary_base / amt_base : la valeur importée de l'Excel, pour « Réinitialiser » (NULL pour
  // une personne ajoutée dans l'app). start_mo / end_mo : 0 = janvier … 11 = décembre.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_employees (
      id           SERIAL PRIMARY KEY,
      budget_id    INT NOT NULL REFERENCES finance_budgets(id) ON DELETE CASCADE,
      ent          TEXT NOT NULL,
      dept         TEXT NOT NULL,
      name         TEXT NOT NULL,
      salary       NUMERIC NOT NULL DEFAULT 0,
      salary_base  NUMERIC,
      alloc        NUMERIC NOT NULL DEFAULT 1,
      map          TEXT NOT NULL,
      raise_pct    NUMERIC,
      raise_mo     INT,
      burden_pct   NUMERIC,
      start_mo     INT NOT NULL DEFAULT 0,
      end_mo       INT,
      sort         INT NOT NULL DEFAULT 0,
      created_by   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_contractors (
      id           SERIAL PRIMARY KEY,
      budget_id    INT NOT NULL REFERENCES finance_budgets(id) ON DELETE CASCADE,
      co           TEXT NOT NULL DEFAULT '',
      name         TEXT NOT NULL DEFAULT '',
      svc          TEXT NOT NULL DEFAULT '',
      rate         NUMERIC,
      hours        NUMERIC,
      amt          NUMERIC NOT NULL DEFAULT 0,
      amt_base     NUMERIC,
      map          TEXT NOT NULL,
      dept         TEXT NOT NULL DEFAULT '',
      start_mo     INT NOT NULL DEFAULT 0,
      end_mo       INT,
      sort         INT NOT NULL DEFAULT 0,
      created_by   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS finance_employees_budget ON finance_employees (budget_id, sort, id)');
  await pool.query('CREATE INDEX IF NOT EXISTS finance_contractors_budget ON finance_contractors (budget_id, sort, id)');
}

// Rôle livré avec la section, à attribuer à la CFO. ON CONFLICT : jamais écrasé s'il a été
// modifié depuis l'Admin.
async function seedRole(pool) {
  await pool.query(
    `INSERT INTO roles (name, description, permissions, is_system)
     VALUES ('Finance (CFO)', 'Finance section: budgets, drivers, payroll and OPEX; approves and unlocks budgets',
             $1::jsonb, false)
     ON CONFLICT (name) DO NOTHING`,
    [JSON.stringify([PERM_VIEW, PERM_EDIT, PERM_PAYROLL, PERM_APPROVE])]);
}

// ---------------------------------------------------------------------------- lecture des lignes
const n = (v) => (v == null ? null : Number(v));
const empOut = (r) => ({
  id: r.id, ent: r.ent, dept: r.dept, name: r.name, salary: n(r.salary), salaryBase: n(r.salary_base),
  alloc: n(r.alloc), map: r.map, raisePct: n(r.raise_pct), raiseMo: r.raise_mo, burdenPct: n(r.burden_pct),
  startMo: r.start_mo, endMo: r.end_mo,
});
const conOut = (r) => ({
  id: r.id, co: r.co, name: r.name, svc: r.svc, rate: n(r.rate), hours: n(r.hours), amt: n(r.amt),
  amtBase: n(r.amt_base), map: r.map, dept: r.dept, startMo: r.start_mo, endMo: r.end_mo,
});
const budgetOut = (b) => ({
  id: b.id, fiscalYear: b.fiscal_year, entity: b.entity, status: b.status,
  approvedBy: b.approved_by, approvedAt: b.approved_at, importedAt: b.imported_at, updatedAt: b.updated_at,
});

// ---------------------------------------------------------------------------- validation
const finite = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < MAX_ABS;
const month = (v) => Number.isInteger(v) && v >= 0 && v <= 11;
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function editableOpexKeys(ref) {
  return new Set((ref.opex || []).filter((it) => it.t === 'line' && !it.pay && !TRAVEL_KEYS.includes(it.key)).map((it) => it.key));
}

// Chaque section a sa forme ; tout le reste est refusé (une valeur folle casserait la page de
// la CFO, qui la recalculerait à chaque ouverture).
function validateSection(section, data, ref) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'bad_data';
  if (section === 'drivers') {
    const keys = new Set(Object.keys(ref.drvDefaults || {}));
    const drv = data.drv || {};
    if (typeof drv !== 'object' || Array.isArray(drv)) return 'bad_drv';
    for (const [k, a] of Object.entries(drv)) {
      if (!keys.has(k)) return `unknown_driver:${k}`;
      if (!Array.isArray(a) || a.length !== 12 || !a.every(finite)) return `bad_driver:${k}`;
    }
    return { drv };
  }
  if (section === 'opex') {
    const keys = editableOpexKeys(ref);
    const opx = data.opx || {}, opxG = data.opxG || {};
    if (typeof opx !== 'object' || typeof opxG !== 'object') return 'bad_opex';
    for (const [k, cells] of Object.entries(opx)) {
      if (!keys.has(k)) return `unknown_opex:${k}`;
      if (!cells || typeof cells !== 'object' || Array.isArray(cells)) return `bad_opex:${k}`;
      for (const [i, v] of Object.entries(cells)) if (!month(Number(i)) || String(Number(i)) !== i || !finite(v)) return `bad_opex:${k}`;
    }
    for (const [k, g] of Object.entries(opxG)) {
      if (!keys.has(k)) return `unknown_opex:${k}`;
      if (!finite(g) || Math.abs(g) > 100) return `bad_growth:${k}`;
    }
    return { opx, opxG };
  }
  if (section === 'trips') {
    if (data.trips === null) return { trips: null };
    if (!Array.isArray(data.trips) || data.trips.length > 200) return 'bad_trips';
    const trips = [];
    for (const t of data.trips) {
      if (!t || typeof t.name !== 'string' || t.name.length > 120 || !TRIP_DEPTS.includes(t.dept) || !month(t.month)) return 'bad_trip';
      const out = { name: t.name, dept: t.dept, month: t.month };
      for (const f of ['people', 'airfare', 'nights', 'hotel', 'days', 'perDiem', 'other']) {
        if (!finite(t[f]) || t[f] < 0) return `bad_trip:${f}`;
        out[f] = t[f];
      }
      trips.push(out);
    }
    return { trips };
  }
  if (section === 'payroll') {
    const { burden, raise, raiseMo } = data;
    if (!finite(burden) || burden < 0 || burden > 100) return 'bad_burden';
    if (!finite(raise) || raise < -100 || raise > 100) return 'bad_raise';
    if (!month(raiseMo)) return 'bad_raise_month';
    return { burden, raise, raiseMo };
  }
  return 'unknown_section';
}

// Employé / contractuel : création (tous les champs obligatoires) ou modification (partielle).
function validatePerson(kind, body, partial) {
  const b = body || {};
  const out = {};
  const want = (k) => !partial || Object.prototype.hasOwnProperty.call(b, k);
  if (kind === 'employee') {
    if (want('ent')) { if (!ENTITIES.includes(b.ent)) return { error: 'bad_ent' }; out.ent = b.ent; }
    if (want('dept')) { if (!str(b.dept, 60)) return { error: 'bad_dept' }; out.dept = b.dept.trim().toUpperCase(); }
    if (want('name')) { if (!str(b.name, 120)) return { error: 'bad_name' }; out.name = b.name.trim(); }
    if (want('salary')) { if (!finite(b.salary) || b.salary < 0) return { error: 'bad_salary' }; out.salary = b.salary; }
    if (want('alloc')) { if (!finite(b.alloc) || b.alloc < 0 || b.alloc > 1) return { error: 'bad_alloc' }; out.alloc = b.alloc; }
    if (want('raisePct') && b.raisePct != null) { if (!finite(b.raisePct) || Math.abs(b.raisePct) > 100) return { error: 'bad_raise' }; }
    if (want('raisePct')) out.raise_pct = b.raisePct == null ? null : b.raisePct;
    if (want('raiseMo') && b.raiseMo != null && !month(b.raiseMo)) return { error: 'bad_raise_month' };
    if (want('raiseMo')) out.raise_mo = b.raiseMo == null ? null : b.raiseMo;
    if (want('burdenPct') && b.burdenPct != null) { if (!finite(b.burdenPct) || b.burdenPct < 0 || b.burdenPct > 100) return { error: 'bad_burden' }; }
    if (want('burdenPct')) out.burden_pct = b.burdenPct == null ? null : b.burdenPct;
  } else {
    if (want('co')) { if (typeof b.co !== 'string' || b.co.length > 120) return { error: 'bad_co' }; out.co = b.co.trim(); }
    if (want('name')) { if (typeof b.name !== 'string' || b.name.length > 120) return { error: 'bad_name' }; out.name = b.name.trim(); }
    if (want('svc')) { if (typeof b.svc !== 'string' || b.svc.length > 200) return { error: 'bad_svc' }; out.svc = b.svc.trim(); }
    if (want('dept')) { if (typeof b.dept !== 'string' || b.dept.length > 60) return { error: 'bad_dept' }; out.dept = b.dept.trim().toUpperCase(); }
    if (want('amt')) { if (!finite(b.amt) || b.amt < 0) return { error: 'bad_amount' }; out.amt = b.amt; }
    if (want('rate')) { if (b.rate != null && (!finite(b.rate) || b.rate < 0)) return { error: 'bad_rate' }; out.rate = b.rate == null ? null : b.rate; }
    if (want('hours')) { if (b.hours != null && (!finite(b.hours) || b.hours < 0)) return { error: 'bad_hours' }; out.hours = b.hours == null ? null : b.hours; }
    if (!partial && !(out.co || out.name)) return { error: 'bad_name' };
  }
  if (want('map')) { if (!MAPS.includes(b.map)) return { error: 'bad_map' }; out.map = b.map; }
  if (want('startMo')) { const s = b.startMo == null ? 0 : b.startMo; if (!month(s)) return { error: 'bad_start' }; out.start_mo = s; }
  if (want('endMo')) { if (b.endMo != null && !month(b.endMo)) return { error: 'bad_end' }; out.end_mo = b.endMo == null ? null : b.endMo; }
  if (!partial && out.end_mo != null && out.end_mo < out.start_mo) return { error: 'end_before_start' };
  return { fields: out };
}

function registerFinanceRoutes(app, deps) {
  const { authenticateToken, requirePerm, hasPerm, pool, logActivity } = deps;

  let ready = null;
  const schema = () => (ready = ready || ensureSchema(pool).catch((e) => { ready = null; throw e; }));
  if (pool) {
    schema().catch((e) => console.error('finance schema:', e.message));
    // `roles` est créée par initializeDatabase() de server.js : on attend qu'elle existe.
    const t = setTimeout(() => { seedRole(pool).catch((e) => console.warn('finance role seed:', e.message)); }, 20000);
    if (t.unref) t.unref();
  }

  const can = async (req, perm) => { try { return await hasPerm(req, perm); } catch { return false; } };
  const lastSaveLog = new Map();

  // Garde commune : authentifié, hors mode démo (ce sont les vrais chiffres de l'entreprise —
  // le brouilleur du mode démo ne touche pas aux tableaux de nombres), permission de lecture.
  async function guard(req, res, perm = PERM_VIEW) {
    if (req.user && req.user.isDemo) { res.status(403).json({ error: 'demo_blocked', demo: true }); return false; }
    await schema();
    return requirePerm(req, res, perm);
  }

  async function loadBudget(id) {
    const r = await pool.query('SELECT * FROM finance_budgets WHERE id = $1', [id]);
    return r.rows[0] || null;
  }

  // Budget modifiable ? Sinon la réponse est déjà envoyée.
  async function writable(req, res, extraPerm) {
    if (!(await guard(req, res, PERM_EDIT))) return null;
    if (extraPerm && !(await requirePerm(req, res, extraPerm))) return null;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: 'bad_id' }); return null; }
    const b = await loadBudget(id);
    if (!b) { res.status(404).json({ error: 'not_found' }); return null; }
    if (b.status === 'approved') { res.status(409).json({ error: 'locked', approvedBy: b.approved_by, approvedAt: b.approved_at }); return null; }
    return b;
  }

  async function roster(budgetId) {
    const [e, c] = await Promise.all([
      pool.query('SELECT * FROM finance_employees WHERE budget_id = $1 ORDER BY sort, id', [budgetId]),
      pool.query('SELECT * FROM finance_contractors WHERE budget_id = $1 ORDER BY sort, id', [budgetId]),
    ]);
    return { employees: e.rows.map(empOut), contractors: c.rows.map(conOut) };
  }

  async function payrollGlobals(budgetId) {
    const r = await pool.query("SELECT data FROM finance_state WHERE budget_id = $1 AND section = 'payroll'", [budgetId]);
    return { ...DEFAULT_PAYROLL, ...((r.rows[0] && r.rows[0].data) || {}) };
  }

  const touch = (id) => pool.query('UPDATE finance_budgets SET updated_at = NOW() WHERE id = $1', [id]);

  // ------------------------------------------------------------------------ GET budget
  app.get('/api/finance/budget', authenticateToken, async (req, res) => {
    try {
      if (!(await guard(req, res))) return;
      const fy = Number(req.query.fy) || 2027;
      const r = await pool.query("SELECT * FROM finance_budgets WHERE fiscal_year = $1 AND entity = 'consolidated'", [fy]);
      const b = r.rows[0];
      const caps = {
        canEdit: await can(req, PERM_EDIT),
        canPayroll: await can(req, PERM_PAYROLL),
        canApprove: await can(req, PERM_APPROVE),
      };
      if (!b) return res.json({ empty: true, fiscalYear: fy, caps });
      const st = await pool.query('SELECT section, data, version, updated_by, updated_at FROM finance_state WHERE budget_id = $1', [b.id]);
      const state = {};
      for (const s of st.rows) state[s.section] = { data: s.data, version: s.version, updatedBy: s.updated_by, updatedAt: s.updated_at };
      const ros = await roster(b.id);
      const globals = { ...DEFAULT_PAYROLL, ...((state.payroll && state.payroll.data) || {}) };
      const payCodes = [...new Set((b.reference.opex || []).filter((it) => it.pay).map((it) => it.pay))];
      const body = {
        budget: budgetOut(b),
        reference: b.reference,
        state,
        payrollGlobals: globals,
        payroll: payrollAggregate(ros.employees, ros.contractors, globals, payCodes),
        caps,
      };
      if (caps.canPayroll) body.roster = ros;
      res.json(body);
    } catch (e) {
      console.error('finance budget:', e.message);
      res.status(500).json({ error: 'load_failed' });
    }
  });

  // ------------------------------------------------------------------------ PUT state/:section
  // Concurrence optimiste : le client renvoie la version qu'il a lue. Si quelqu'un a enregistré
  // entre-temps, 409 + la version courante — le client recharge plutôt que d'écraser.
  app.put('/api/finance/budgets/:id/state/:section', authenticateToken, async (req, res) => {
    try {
      const section = req.params.section;
      if (!SECTIONS.includes(section)) return res.status(400).json({ error: 'unknown_section' });
      const b = await writable(req, res, section === 'payroll' ? PERM_PAYROLL : null);
      if (!b) return;
      const v = validateSection(section, req.body && req.body.data, b.reference);
      if (typeof v === 'string') return res.status(400).json({ error: v });
      const version = Number(req.body.version) || 0;
      const email = req.user.email;
      let out;
      if (version === 0) {
        out = await pool.query(
          `INSERT INTO finance_state (budget_id, section, data, version, updated_by) VALUES ($1, $2, $3::jsonb, 1, $4)
           ON CONFLICT (budget_id, section) DO NOTHING RETURNING version`,
          [b.id, section, JSON.stringify(v), email]);
      } else {
        out = await pool.query(
          `UPDATE finance_state SET data = $3::jsonb, version = version + 1, updated_by = $4, updated_at = NOW()
           WHERE budget_id = $1 AND section = $2 AND version = $5 RETURNING version`,
          [b.id, section, JSON.stringify(v), email, version]);
      }
      if (!out.rows[0]) {
        const cur = await pool.query('SELECT data, version, updated_by, updated_at FROM finance_state WHERE budget_id = $1 AND section = $2', [b.id, section]);
        const c = cur.rows[0];
        return res.status(409).json({ error: 'conflict', current: c ? { data: c.data, version: c.version, updatedBy: c.updated_by, updatedAt: c.updated_at } : null });
      }
      await touch(b.id);
      const empty = section === 'drivers' ? !Object.keys(v.drv).length
        : section === 'opex' ? !Object.keys(v.opx).length && !Object.keys(v.opxG).length
          : section === 'trips' ? v.trips === null : false;
      const k = `${b.id}|${section}|${email}`;
      const now = Date.now();
      if (empty) {
        await logActivity('finance_budget', String(b.id), 'reset', `Budget ${b.fiscal_year} : section « ${section} » réinitialisée`, email, { metadata: { section } });
        lastSaveLog.delete(k);
      } else if (!lastSaveLog.has(k) || now - lastSaveLog.get(k) > SAVE_LOG_EVERY_MS) {
        lastSaveLog.set(k, now);
        await logActivity('finance_budget', String(b.id), 'edited', `Budget ${b.fiscal_year} : section « ${section} » modifiée`, email, { metadata: { section } });
      }
      res.json({ version: out.rows[0].version });
    } catch (e) {
      console.error('finance state:', e.message);
      res.status(500).json({ error: 'save_failed' });
    }
  });

  // ------------------------------------------------------------------------ effectif
  const TABLES = {
    employees: { table: 'finance_employees', kind: 'employee', out: empOut, label: 'Employé' },
    contractors: { table: 'finance_contractors', kind: 'contractor', out: conOut, label: 'Contractuel' },
  };

  for (const [path, T] of Object.entries(TABLES)) {
    app.post(`/api/finance/budgets/:id/${path}`, authenticateToken, async (req, res) => {
      try {
        const b = await writable(req, res, PERM_PAYROLL);
        if (!b) return;
        const v = validatePerson(T.kind, req.body, false);
        if (v.error) return res.status(400).json({ error: v.error });
        const f = { ...v.fields, budget_id: b.id, created_by: req.user.email };
        const s = await pool.query(`SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM ${T.table} WHERE budget_id = $1`, [b.id]);
        f.sort = s.rows[0].s;
        const cols = Object.keys(f);
        const r = await pool.query(
          `INSERT INTO ${T.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          cols.map((c) => f[c]));
        await touch(b.id);
        const row = T.out(r.rows[0]);
        await logActivity('finance_budget', String(b.id), `${T.kind}_added`, `${T.label} ajouté : ${row.name || row.co}`, req.user.email, { metadata: { id: row.id } });
        res.json({ [T.kind]: row });
      } catch (e) {
        console.error(`finance ${path} add:`, e.message);
        res.status(500).json({ error: 'save_failed' });
      }
    });

    app.patch(`/api/finance/budgets/:id/${path}/:pid`, authenticateToken, async (req, res) => {
      try {
        const b = await writable(req, res, PERM_PAYROLL);
        if (!b) return;
        const v = validatePerson(T.kind, req.body, true);
        if (v.error) return res.status(400).json({ error: v.error });
        const cols = Object.keys(v.fields);
        if (!cols.length) return res.status(400).json({ error: 'nothing_to_update' });
        const before = await pool.query(`SELECT * FROM ${T.table} WHERE id = $1 AND budget_id = $2`, [Number(req.params.pid), b.id]);
        if (!before.rows[0]) return res.status(404).json({ error: 'not_found' });
        const start = 'start_mo' in v.fields ? v.fields.start_mo : before.rows[0].start_mo;
        const end = 'end_mo' in v.fields ? v.fields.end_mo : before.rows[0].end_mo;
        if (end != null && end < start) return res.status(400).json({ error: 'end_before_start' });
        const r = await pool.query(
          `UPDATE ${T.table} SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = NOW()
           WHERE id = $1 AND budget_id = $2 RETURNING *`,
          [Number(req.params.pid), b.id, ...cols.map((c) => v.fields[c])]);
        if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
        // Bloc de journal par minute et par personne : une frappe dans un montant ne laisse
        // pas dix lignes.
        const row = T.out(r.rows[0]);
        const k = `${b.id}|${T.kind}|${row.id}|${req.user.email}`;
        const now = Date.now();
        if (!lastSaveLog.has(k) || now - lastSaveLog.get(k) > SAVE_LOG_EVERY_MS) {
          lastSaveLog.set(k, now);
          const prev = before.rows[0];
          const changed = cols.filter((c) => String(prev[c]) !== String(r.rows[0][c]));
          await logActivity('finance_budget', String(b.id), `${T.kind}_edited`, `${T.label} modifié : ${row.name || row.co} (${changed.join(', ') || 'aucun changement'})`, req.user.email, { metadata: { id: row.id, fields: changed } });
        }
        await touch(b.id);
        res.json({ [T.kind]: row });
      } catch (e) {
        console.error(`finance ${path} edit:`, e.message);
        res.status(500).json({ error: 'save_failed' });
      }
    });

    app.delete(`/api/finance/budgets/:id/${path}/:pid`, authenticateToken, async (req, res) => {
      try {
        const b = await writable(req, res, PERM_PAYROLL);
        if (!b) return;
        const r = await pool.query(`DELETE FROM ${T.table} WHERE id = $1 AND budget_id = $2 RETURNING *`, [Number(req.params.pid), b.id]);
        if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
        await touch(b.id);
        const row = T.out(r.rows[0]);
        await logActivity('finance_budget', String(b.id), `${T.kind}_removed`, `${T.label} retiré : ${row.name || row.co}`, req.user.email, { metadata: { id: row.id } });
        res.json({ ok: true });
      } catch (e) {
        console.error(`finance ${path} delete:`, e.message);
        res.status(500).json({ error: 'save_failed' });
      }
    });
  }

  // Réinitialiser la paie = réglages globaux d'origine, plus de valeurs propres à une personne,
  // salaires et montants importés rétablis. Les personnes ajoutées ou retirées le restent.
  app.post('/api/finance/budgets/:id/payroll/reset', authenticateToken, async (req, res) => {
    try {
      const b = await writable(req, res, PERM_PAYROLL);
      if (!b) return;
      await pool.query(
        `UPDATE finance_employees SET raise_pct = NULL, raise_mo = NULL, burden_pct = NULL,
           salary = COALESCE(salary_base, salary), updated_at = NOW() WHERE budget_id = $1`, [b.id]);
      await pool.query('UPDATE finance_contractors SET amt = COALESCE(amt_base, amt), updated_at = NOW() WHERE budget_id = $1', [b.id]);
      await pool.query(
        `INSERT INTO finance_state (budget_id, section, data, version, updated_by) VALUES ($1, 'payroll', $2::jsonb, 1, $3)
         ON CONFLICT (budget_id, section) DO UPDATE SET data = EXCLUDED.data, version = finance_state.version + 1,
           updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [b.id, JSON.stringify(DEFAULT_PAYROLL), req.user.email]);
      await touch(b.id);
      await logActivity('finance_budget', String(b.id), 'reset', `Budget ${b.fiscal_year} : paie réinitialisée`, req.user.email, { metadata: { section: 'payroll' } });
      const st = await pool.query("SELECT version FROM finance_state WHERE budget_id = $1 AND section = 'payroll'", [b.id]);
      res.json({ roster: await roster(b.id), payrollGlobals: DEFAULT_PAYROLL, version: st.rows[0].version });
    } catch (e) {
      console.error('finance payroll reset:', e.message);
      res.status(500).json({ error: 'save_failed' });
    }
  });

  // ------------------------------------------------------------------------ approbation
  for (const [action, status] of [['approve', 'approved'], ['unlock', 'draft']]) {
    app.post(`/api/finance/budgets/:id/${action}`, authenticateToken, async (req, res) => {
      try {
        if (!(await guard(req, res, PERM_APPROVE))) return;
        const id = Number(req.params.id);
        const r = await pool.query(
          `UPDATE finance_budgets SET status = $2,
             approved_by = CASE WHEN $2 = 'approved' THEN $3 ELSE NULL END,
             approved_at = CASE WHEN $2 = 'approved' THEN NOW() ELSE NULL END,
             updated_at = NOW()
           WHERE id = $1 AND status <> $2 RETURNING *`,
          [id, status, req.user.email]);
        if (!r.rows[0]) {
          const b = await loadBudget(id);
          if (!b) return res.status(404).json({ error: 'not_found' });
          return res.json({ budget: budgetOut(b) }); // déjà dans cet état
        }
        const b = r.rows[0];
        await logActivity('finance_budget', String(b.id), action === 'approve' ? 'approved' : 'unlocked',
          action === 'approve' ? `Budget ${b.fiscal_year} approuvé et verrouillé` : `Budget ${b.fiscal_year} déverrouillé`,
          req.user.email);
        res.json({ budget: budgetOut(b) });
      } catch (e) {
        console.error(`finance ${action}:`, e.message);
        res.status(500).json({ error: 'save_failed' });
      }
    });
  }

  return { ensureReady: schema };
}

module.exports = {
  registerFinanceRoutes, ensureSchema, seedRole, validateSection, validatePerson, DEFAULT_PAYROLL,
  PERMS: { PERM_VIEW, PERM_EDIT, PERM_PAYROLL, PERM_APPROVE },
};
