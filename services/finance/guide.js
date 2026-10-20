// ============================================================================
// Module Finance — lot H : guide de questions aux gestionnaires, pistes d'économies tirées des
// réels, règle des 40 et repères SaaS / POS. Permission : finance:guide (+ finance:view) ;
// écriture des repères et des responsables de comptes = + finance:edit.
//
// Ce que fait le serveur (les QUESTIONS et la règle des 40 du modèle FY2027 se calculent dans le
// navigateur, comme tout le reste du budget : src/pages/Finance/Guide/guideModel.ts) :
//   - notes de l'usager sur chaque question (par usager, versionnées) ;
//   - analyse des réels du grand livre (finance_gl_raw, remplie par la synchro Zoho Books du lot B) :
//     hausses vs les 3 mois précédents / vs l'an dernier, plus gros comptes, comptes à assigner ;
//   - table compte → responsable / département (finance_guide_account_owner) — aucune devinette ;
//   - table des repères (finance_benchmarks), semée depuis guideBenchmarks.json (versionné, sourcé).
//
// 🔑 Aucune réponse de ce fichier ne contient de nom d'employé, de salaire ni de client : seulement
// des comptes du grand livre et des montants agrégés. Le banc d'essai le vérifie.
// ============================================================================

const fs = require('fs');
const path = require('path');
const G = require('./guideCore');

const PERM_GUIDE = 'finance:guide';
const PERM_VIEW = 'finance:view';
const PERM_EDIT = 'finance:edit';
const ENTITY = 'finance_guide';
const TRAVEL_KEYS = ['smTravel', 'rdTravel', 'gaTravel'];
const QID_RE = /^[A-Za-z0-9:_.-]{1,120}$/;
const NOTE_STATES = ['new', 'asked', 'answered'];
const MAX_NOTE = 4000;
const MAX_BATCH = 500;

function loadShipped() {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'guideBenchmarks.json'), 'utf8'));
  const out = [];
  for (const b of j.benchmarks) {
    const v = G.validateBenchmark(b);
    if (v.error) throw new Error(`guideBenchmarks.json : repère ${b && b.id} refusé (${v.error})`);
    out.push(v.row);
  }
  return { version: j.version, rows: out };
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_guide_notes (
      user_email TEXT NOT NULL,
      qid        TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      state      TEXT NOT NULL DEFAULT 'new',
      version    INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_email, qid)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_guide_account_owner (
      account_key  TEXT PRIMARY KEY,
      account_name TEXT NOT NULL DEFAULT '',
      owner        TEXT NOT NULL,
      department   TEXT NOT NULL,
      budget_line  TEXT,
      version      INT NOT NULL DEFAULT 1,
      updated_by   TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_benchmarks (
      id            TEXT PRIMARY KEY,
      metric        TEXT NOT NULL,
      label_en      TEXT NOT NULL,
      label_fr      TEXT NOT NULL,
      value         NUMERIC,
      unit          TEXT NOT NULL,
      direction     TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'public',
      use_for_flags BOOLEAN NOT NULL DEFAULT TRUE,
      source_org    TEXT,
      source_url    TEXT,
      source_year   INT,
      source_date   DATE,
      note          TEXT,
      origin        TEXT NOT NULL DEFAULT 'shipped',
      edited        BOOLEAN NOT NULL DEFAULT FALSE,
      entered_by    TEXT,
      version       INT NOT NULL DEFAULT 1,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Semis : jamais d'écrasement d'une ligne existante (la CFO a pu la modifier).
  const shipped = loadShipped();
  for (const r of shipped.rows) {
    await pool.query(
      `INSERT INTO finance_benchmarks (id, metric, label_en, label_fr, value, unit, direction, kind, use_for_flags, source_org, source_url, source_year, source_date, note, origin, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14,'shipped','shipped')
       ON CONFLICT (id) DO NOTHING`,
      [r.id, r.metric, r.label_en, r.label_fr, r.value, r.unit, r.direction, r.kind, r.use_for_flags, r.source_org, r.source_url, r.source_year, r.source_date, r.note]);
  }
}

const bOut = (r) => ({
  id: r.id, metric: r.metric, labelEn: r.label_en, labelFr: r.label_fr, value: r.value == null ? null : Number(r.value), unit: r.unit, direction: r.direction,
  kind: r.kind, useForFlags: r.use_for_flags, sourceOrg: r.source_org, sourceUrl: r.source_url, sourceYear: r.source_year,
  sourceDate: r.source_date ? (r.source_date instanceof Date ? r.source_date.toISOString().slice(0, 10) : String(r.source_date).slice(0, 10)) : null,
  note: r.note, origin: r.origin, edited: r.edited, enteredBy: r.entered_by, version: r.version, updatedAt: r.updated_at,
});

const missingTable = (e) => e && (e.code === '42P01' || /does not exist|no such table/i.test(String(e.message)));

function register(app, kit) {
  const { pool, authenticateToken, logActivity } = kit;
  if (!pool) return;
  let ready = null;
  const schema = () => (ready = ready || ensureSchema(pool).catch((e) => { ready = null; throw e; }));
  schema().catch((e) => console.error('finance guide schema:', e.message));

  const canRead = async (req, res) => { if (!(await kit.guardAll(req, res, [PERM_GUIDE, PERM_VIEW]))) return false; await schema(); return true; };
  const canWrite = async (req, res) => { if (!(await kit.guardAll(req, res, [PERM_GUIDE, PERM_VIEW, PERM_EDIT]))) return false; await schema(); return true; };
  const fail = (res, tag) => (e) => { console.error(`finance guide ${tag}:`, e.message); res.status(500).json({ error: 'server_error' }); };

  // ------------------------------------------------------------------------ notes (par usager)
  app.get('/api/finance/guide/notes', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res))) return;
      const r = await pool.query('SELECT qid, note, state, version, updated_at FROM finance_guide_notes WHERE user_email = $1', [req.user.email]);
      res.json({ notes: r.rows.map((x) => ({ qid: x.qid, note: x.note, state: x.state, version: x.version, updatedAt: x.updated_at })) });
    } catch (e) { fail(res, 'notes')(e); }
  });

  // Une note est PERSONNELLE : seule la permission du guide est requise (pas finance:edit), elle ne
  // modifie rien du budget. Concurrence optimiste (deux onglets du même usager).
  app.put('/api/finance/guide/notes/:qid', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res))) return;
      const qid = req.params.qid;
      if (!QID_RE.test(qid)) return res.status(400).json({ error: 'bad_qid' });
      const b = req.body || {};
      const note = b.note === undefined ? '' : b.note;
      const state = b.state === undefined ? 'new' : b.state;
      if (typeof note !== 'string' || note.length > MAX_NOTE) return res.status(400).json({ error: 'bad_note' });
      if (!NOTE_STATES.includes(state)) return res.status(400).json({ error: 'bad_state' });
      const version = Number(b.version) || 0;
      let out;
      if (version === 0) {
        out = await pool.query(
          `INSERT INTO finance_guide_notes (user_email, qid, note, state, version) VALUES ($1,$2,$3,$4,1)
           ON CONFLICT (user_email, qid) DO NOTHING RETURNING version`, [req.user.email, qid, note, state]);
      } else {
        out = await pool.query(
          `UPDATE finance_guide_notes SET note = $3, state = $4, version = version + 1, updated_at = NOW()
            WHERE user_email = $1 AND qid = $2 AND version = $5 RETURNING version`, [req.user.email, qid, note, state, version]);
      }
      if (!out.rows[0]) {
        const cur = await pool.query('SELECT note, state, version FROM finance_guide_notes WHERE user_email = $1 AND qid = $2', [req.user.email, qid]);
        return res.status(409).json({ error: 'conflict', current: cur.rows[0] ? { note: cur.rows[0].note, state: cur.rows[0].state, version: cur.rows[0].version } : null });
      }
      res.json({ version: out.rows[0].version });
    } catch (e) { fail(res, 'note save')(e); }
  });

  // ------------------------------------------------------------------------ réels du grand livre
  async function loadOwners() {
    const r = await pool.query('SELECT account_key, owner, department, budget_line FROM finance_guide_account_owner');
    const o = {};
    for (const x of r.rows) o[x.account_key] = { owner: x.owner, department: x.department, budgetLine: x.budget_line };
    return o;
  }

  async function loadGl() {
    try {
      const rows = (await pool.query(
        `SELECT to_char(month, 'YYYY-MM') AS m, account_key AS key, account_name AS name, section, amount::float8 AS amount
           FROM finance_gl_raw WHERE NOT is_group`)).rows;
      const months = (await pool.query("SELECT to_char(month, 'YYYY-MM') AS m FROM finance_gl_raw_months")).rows.map((x) => x.m);
      return { rows, months };
    } catch (e) {
      if (missingTable(e)) return { rows: [], months: [] }; // synchro du lot B jamais lancée
      throw e;
    }
  }

  async function booksStatus() {
    try {
      const r = await pool.query("SELECT state, last_ok_at, last_error FROM finance_kpi_sync_status WHERE source = 'books'");
      return r.rows[0] ? { state: r.rows[0].state, lastOkAt: r.rows[0].last_ok_at, error: r.rows[0].last_error ? 'see_kpi_sources' : null } : { state: 'never', lastOkAt: null, error: null };
    } catch (e) {
      if (missingTable(e)) return { state: 'never', lastOkAt: null, error: null };
      throw e;
    }
  }

  const now = () => new Date();

  app.get('/api/finance/guide/savings', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res))) return;
      const [gl, owners, books] = await Promise.all([loadGl(), loadOwners(), booksStatus()]);
      const a = G.analyzeActuals({ rows: gl.rows, syncedMonths: gl.months, owners, now: now() });
      const known = [...new Set(Object.values(owners).map((o) => o.owner))].sort();
      res.json({ ...a, books, knownOwners: known, departments: G.DEPARTMENTS, caps: { canEdit: await kit.can(req, PERM_EDIT) } });
    } catch (e) { fail(res, 'savings')(e); }
  });

  // Lignes de budget auxquelles un compte peut être rattaché (OPEX modifiables du budget consolidé).
  async function budgetLineKeys() {
    try {
      const r = await pool.query("SELECT reference FROM finance_budgets WHERE entity = 'consolidated' ORDER BY fiscal_year DESC LIMIT 1");
      if (!r.rows[0]) return null;
      const ref = r.rows[0].reference || {};
      return new Set((ref.opex || []).filter((it) => it.t === 'line' && !it.pay && !TRAVEL_KEYS.includes(it.key)).map((it) => `opx:${it.key}`));
    } catch (e) { if (missingTable(e)) return null; throw e; }
  }

  app.put('/api/finance/guide/accounts/owners', authenticateToken, async (req, res) => {
    try {
      if (!(await canWrite(req, res))) return;
      const b = req.body || {};
      const list = Array.isArray(b.assignments) ? b.assignments : [];
      const clear = Array.isArray(b.clear) ? b.clear : [];
      if (!list.length && !clear.length) return res.status(400).json({ error: 'nothing_to_do' });
      if (list.length + clear.length > MAX_BATCH) return res.status(400).json({ error: 'too_many' });
      const lines = await budgetLineKeys();
      const gl = await loadGl();
      const names = new Map(gl.rows.map((r) => [r.key, r.name]));
      const clean = [];
      for (const a of list) {
        if (!a || typeof a.accountKey !== 'string' || !a.accountKey || a.accountKey.length > 400) return res.status(400).json({ error: 'bad_account' });
        if (!names.has(a.accountKey)) return res.status(400).json({ error: 'unknown_account' });
        const owner = typeof a.owner === 'string' ? a.owner.trim() : '';
        if (!owner || owner.length > 80) return res.status(400).json({ error: 'bad_owner' });
        if (!G.DEPARTMENTS.includes(a.department)) return res.status(400).json({ error: 'bad_department' });
        const bl = a.budgetLine == null || a.budgetLine === '' ? null : a.budgetLine;
        if (bl !== null && (typeof bl !== 'string' || !/^opx:[A-Za-z0-9_]{1,60}$/.test(bl) || (lines && !lines.has(bl)))) return res.status(400).json({ error: 'bad_budget_line' });
        clean.push({ key: a.accountKey, name: String(names.get(a.accountKey)).slice(0, 300), owner, department: a.department, bl });
      }
      for (const k of clear) if (typeof k !== 'string' || !k || k.length > 400) return res.status(400).json({ error: 'bad_account' });
      for (const c of clean) {
        await pool.query(
          `INSERT INTO finance_guide_account_owner (account_key, account_name, owner, department, budget_line, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (account_key) DO UPDATE SET account_name = EXCLUDED.account_name, owner = EXCLUDED.owner, department = EXCLUDED.department,
             budget_line = EXCLUDED.budget_line, version = finance_guide_account_owner.version + 1, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
          [c.key, c.name, c.owner, c.department, c.bl, req.user.email]);
      }
      for (const k of clear) await pool.query('DELETE FROM finance_guide_account_owner WHERE account_key = $1', [k]);
      await logActivity(ENTITY, 'accounts', 'owners_assigned', `Responsables de comptes : ${clean.length} assigné(s), ${clear.length} retiré(s)`, req.user.email, { metadata: { assigned: clean.length, cleared: clear.length } });
      res.json({ assigned: clean.length, cleared: clear.length });
    } catch (e) { fail(res, 'owners')(e); }
  });

  // ------------------------------------------------------------------------ repères
  app.get('/api/finance/guide/benchmarks', authenticateToken, async (req, res) => {
    try {
      if (!(await canRead(req, res))) return;
      const r = await pool.query('SELECT * FROM finance_benchmarks ORDER BY metric, id');
      res.json({ benchmarks: r.rows.map(bOut), metrics: G.METRICS, units: G.UNITS, shippedVersion: loadShipped().version, caps: { canEdit: await kit.can(req, PERM_EDIT) } });
    } catch (e) { fail(res, 'benchmarks')(e); }
  });

  const rowCols = ['metric', 'label_en', 'label_fr', 'value', 'unit', 'direction', 'kind', 'use_for_flags', 'source_org', 'source_url', 'source_year', 'source_date', 'note'];
  const rowVals = (r) => rowCols.map((c) => r[c]);

  app.post('/api/finance/guide/benchmarks', authenticateToken, async (req, res) => {
    try {
      if (!(await canWrite(req, res))) return;
      const b = req.body || {};
      const id = `cfo.${String(b.metric || 'x').replace(/[^a-z0-9_]/g, '')}.${Date.now().toString(36)}`;
      const v = G.validateBenchmark({ ...b, id });
      if (v.error) return res.status(400).json({ error: v.error });
      const r = v.row;
      await pool.query(
        `INSERT INTO finance_benchmarks (id, ${rowCols.join(', ')}, origin, entered_by) VALUES ($1, ${rowCols.map((_, i) => (rowCols[i] === 'source_date' ? `$${i + 2}::date` : `$${i + 2}`)).join(', ')}, 'cfo', $${rowCols.length + 2})`,
        [r.id, ...rowVals(r), req.user.email]);
      await logActivity(ENTITY, r.id, 'benchmark_created', `Repère ajouté : ${r.id}`, req.user.email, { metadata: { id: r.id } });
      const out = await pool.query('SELECT * FROM finance_benchmarks WHERE id = $1', [r.id]);
      res.json({ benchmark: bOut(out.rows[0]) });
    } catch (e) { fail(res, 'benchmark create')(e); }
  });

  app.put('/api/finance/guide/benchmarks/:id', authenticateToken, async (req, res) => {
    try {
      if (!(await canWrite(req, res))) return;
      const b = req.body || {};
      const v = G.validateBenchmark({ ...b, id: req.params.id });
      if (v.error) return res.status(400).json({ error: v.error });
      const r = v.row;
      const version = Number(b.version) || 0;
      const out = await pool.query(
        `UPDATE finance_benchmarks SET ${rowCols.map((c, i) => `${c} = ${c === 'source_date' ? `$${i + 3}::date` : `$${i + 3}`}`).join(', ')},
           edited = TRUE, entered_by = $${rowCols.length + 3}, version = version + 1, updated_at = NOW()
         WHERE id = $1 AND version = $2 RETURNING *`,
        [r.id, version, ...rowVals(r), req.user.email]);
      if (!out.rows[0]) {
        const cur = await pool.query('SELECT * FROM finance_benchmarks WHERE id = $1', [r.id]);
        if (!cur.rows[0]) return res.status(404).json({ error: 'not_found' });
        return res.status(409).json({ error: 'conflict', current: bOut(cur.rows[0]) });
      }
      await logActivity(ENTITY, r.id, 'benchmark_edited', `Repère modifié : ${r.id}`, req.user.email, { metadata: { id: r.id } });
      res.json({ benchmark: bOut(out.rows[0]) });
    } catch (e) { fail(res, 'benchmark edit')(e); }
  });

  app.delete('/api/finance/guide/benchmarks/:id', authenticateToken, async (req, res) => {
    try {
      if (!(await canWrite(req, res))) return;
      const cur = await pool.query('SELECT origin FROM finance_benchmarks WHERE id = $1', [req.params.id]);
      if (!cur.rows[0]) return res.status(404).json({ error: 'not_found' });
      if (cur.rows[0].origin !== 'cfo') return res.status(400).json({ error: 'shipped_not_deletable' });
      await pool.query('DELETE FROM finance_benchmarks WHERE id = $1', [req.params.id]);
      await logActivity(ENTITY, req.params.id, 'benchmark_deleted', `Repère supprimé : ${req.params.id}`, req.user.email, { metadata: { id: req.params.id } });
      res.json({ ok: true });
    } catch (e) { fail(res, 'benchmark delete')(e); }
  });

  // Rétablir un repère livré à sa valeur et sa source d'origine (fichier versionné).
  app.post('/api/finance/guide/benchmarks/:id/reset', authenticateToken, async (req, res) => {
    try {
      if (!(await canWrite(req, res))) return;
      const orig = loadShipped().rows.find((r) => r.id === req.params.id);
      if (!orig) return res.status(400).json({ error: 'not_shipped' });
      const out = await pool.query(
        `UPDATE finance_benchmarks SET ${rowCols.map((c, i) => `${c} = ${c === 'source_date' ? `$${i + 2}::date` : `$${i + 2}`}`).join(', ')},
           edited = FALSE, entered_by = 'shipped', version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [orig.id, ...rowVals(orig)]);
      if (!out.rows[0]) return res.status(404).json({ error: 'not_found' });
      await logActivity(ENTITY, orig.id, 'benchmark_reset', `Repère rétabli : ${orig.id}`, req.user.email, { metadata: { id: orig.id } });
      res.json({ benchmark: bOut(out.rows[0]) });
    } catch (e) { fail(res, 'benchmark reset')(e); }
  });
}

module.exports = { register, ensureSchema, loadShipped };
