// ============================================================================
// Module Finance — approbation PAR DRIVER, responsables par ligne et barre de progression (lot G).
//
// Avant ce lot, l'approbation ne valait que pour un budget ENTIER (verrou de routes.js). Ici, chaque
// driver de revenus / COGS saisissable et chaque ligne OPEX modifiable du budget consolidé FY2027
// a son propre statut, son responsable, et la CFO voit d'un coup d'œil ce qu'il reste à alimenter.
//
//   GET  /api/finance/driver-status              lignes + état affiché + responsables (finance:progress OU driver_approve)
//   POST /api/finance/driver-status/submit       { keys, expect? }          (finance:edit)
//   POST /api/finance/driver-status/approve      { keys, expect? }          (finance:driver_approve + finance:edit)
//   POST /api/finance/driver-status/reopen       { keys, reason, expect? }  (finance:driver_approve + finance:edit)
//   PUT  /api/finance/driver-status/owner        { keys, owner|null }       (finance:edit)
//   POST /api/finance/driver-status/owners/confirm { keys }                 (finance:edit) — enregistre les responsables SUGGÉRÉS
//   POST /api/finance/driver-status/directory    { name }                   (finance:edit)
//   DELETE /api/finance/driver-status/directory/:name                       (finance:edit)
//   GET  /api/finance/progress                   liste de contrôle structurée (finance:progress)
//
// 🔑 L'ÉTAT AFFICHÉ est calculé ICI, jamais cru du client : `default | proposed | submitted | approved
// | stale`. « stale » = approuvé, puis la valeur a changé (hachage SHA-256 des 12 valeurs courantes ≠
// hachage enregistré à l'approbation). Les valeurs courantes se lisent comme le navigateur
// (finance_state 'drivers' / 'opex' sinon la référence) — voir driverApprovalsCore.js.
//
// Concurrence : `expect: { <clé>: { version, hash } }` (facultatif, que l'écran envoie toujours) —
// la version de la ligne et le hachage des valeurs que l'approbateur AVAIT SOUS LES YEUX ; si l'un des
// deux a bougé : 409 `conflict` + la liste des clés, RIEN n'est écrit. Verrou d'approbation du budget
// entier respecté : 409 `locked`.
// Aucun nom ni salaire dans ces réponses : seulement des clés de ligne, des valeurs de drivers / OPEX
// et des responsables saisis par la CFO.
// ============================================================================

const C = require('./driverApprovalsCore');

const PERM_VIEW = 'finance:view';
const PERM_EDIT = 'finance:edit';
const PERM_APPROVE = 'finance:driver_approve';
const PERM_PROGRESS = 'finance:progress';
const FY = 2027;
const ENTITY_ROWS = { budget_cluster: 'cluster', budget_xperio: 'xperio', budget_departments: 'departments' };
const REASON_MAX = 300;
const LOG_KEYS = 50;

// ---------------------------------------------------------------------------- schéma
async function ensureSchema(pool) {
  // Une instruction par appel (PGlite refuse les lots).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_driver_status (
      budget_id      INT NOT NULL REFERENCES finance_budgets(id) ON DELETE CASCADE,
      key            TEXT NOT NULL,
      owner          TEXT,
      status         TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'submitted', 'approved')),
      approved_hash  TEXT,
      approved_by    TEXT,
      approved_at    TIMESTAMPTZ,
      submitted_hash TEXT,
      submitted_by   TEXT,
      submitted_at   TIMESTAMPTZ,
      updated_by     TEXT,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      version        INT NOT NULL DEFAULT 1,
      PRIMARY KEY (budget_id, key)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_owner_directory (
      name       TEXT PRIMARY KEY,
      sort       INT NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Annuaire de départ : une seule fois (repère dans app_settings, quand la table existe), pour que
  // la CFO puisse en retirer un nom sans que le redémarrage le remette.
  const has = await pool.query('SELECT 1 FROM finance_owner_directory LIMIT 1');
  if (has.rows[0]) return;
  let marked = false;
  try { marked = !!(await pool.query("SELECT 1 FROM app_settings WHERE key = 'finance_owner_directory_seeded'")).rows[0]; } catch { /* sans app_settings */ }
  if (marked) return;
  for (const [i, name] of C.DEFAULT_DIRECTORY.entries()) {
    await pool.query('INSERT INTO finance_owner_directory (name, sort, created_by) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING', [name, i + 1, 'system']);
  }
  try { await pool.query("INSERT INTO app_settings (key, value, updated_at) VALUES ('finance_owner_directory_seeded', 'true'::jsonb, NOW()) ON CONFLICT (key) DO NOTHING"); } catch { /* idem */ }
}

// ---------------------------------------------------------------------------- enregistrement
function register(app, kit) {
  const { pool, authenticateToken, logActivity } = kit;
  let ready = null;
  const ensure = async () => {
    await kit.schema();
    return (ready = ready || ensureSchema(pool).catch((e) => { ready = null; throw e; }));
  };
  if (pool) ensure().catch((e) => console.error('finance driver approvals schema:', e.message));

  const fail = (res, e, label) => { console.error(`finance ${label}:`, e.message); res.status(500).json({ error: 'load_failed' }); };

  async function consolidated() {
    const r = await pool.query("SELECT * FROM finance_budgets WHERE fiscal_year = $1 AND entity = 'consolidated'", [FY]);
    return r.rows[0] || null;
  }
  const budgetOut = (b) => ({ id: b.id, status: b.status, approvedBy: b.approved_by, approvedAt: b.approved_at });

  // ------------------------------------------------------------------------ lecture des lignes
  // Toutes les lignes suivies avec leur valeur courante, leur hachage et leur état affiché.
  async function loadCtx(b) {
    const [st, rows, dir] = await Promise.all([
      pool.query("SELECT section, data FROM finance_state WHERE budget_id = $1 AND section IN ('drivers', 'opex')", [b.id]),
      pool.query('SELECT * FROM finance_driver_status WHERE budget_id = $1', [b.id]),
      pool.query('SELECT name FROM finance_owner_directory ORDER BY sort, name'),
    ]);
    const state = {};
    for (const s of st.rows) state[s.section] = s.data;
    const byKey = new Map(rows.rows.map((r) => [r.key, r]));
    const lines = C.buildLines(b.reference).map((l) => {
      const row = byKey.get(l.key) || null;
      const cur = C.lineValues(b.reference, state, l);
      const def = C.lineValues(b.reference, {}, l);
      const hash = C.hashValues(cur.values, cur.growth);
      const defHash = C.hashValues(def.values, def.growth);
      return {
        key: l.key, kind: l.kind, id: l.id, group: l.group, dept: l.dept, name: l.name,
        state: C.displayState(row, hash, defHash),
        modified: hash !== defHash,
        values: cur.values, growth: cur.growth, hash,
        owner: (row && row.owner) || null, suggestedOwner: l.suggestedOwner,
        version: row ? row.version : 0,
        submittedBy: row ? row.submitted_by : null, submittedAt: row ? row.submitted_at : null,
        approvedBy: row && row.status === 'approved' ? row.approved_by : null,
        approvedAt: row && row.status === 'approved' ? row.approved_at : null,
        updatedBy: row ? row.updated_by : null, updatedAt: row ? row.updated_at : null,
      };
    });
    return { lines, directory: dir.rows.map((r) => r.name), summary: C.summarize(lines) };
  }

  // Garde de lecture : finance:view, puis l'une des deux permissions du lot.
  async function readGate(req, res) {
    if (!(await kit.guard(req, res, PERM_VIEW))) return false;
    await ensure();
    if (await kit.can(req, PERM_PROGRESS) || await kit.can(req, PERM_APPROVE)) return true;
    return kit.requirePerm(req, res, PERM_PROGRESS); // envoie le 403
  }
  // Garde d'écriture : finance:view + finance:edit (+ finance:driver_approve), puis budget non verrouillé.
  async function writeGate(req, res, { approve = false } = {}) {
    if (!(await kit.guardAll(req, res, approve ? [PERM_VIEW, PERM_EDIT, PERM_APPROVE] : [PERM_VIEW, PERM_EDIT]))) return null;
    await ensure();
    const b = await consolidated();
    if (!b) { res.status(404).json({ error: 'not_found' }); return null; }
    if (b.status === 'approved') { res.status(409).json({ error: 'locked', approvedBy: b.approved_by, approvedAt: b.approved_at }); return null; }
    return b;
  }

  // ------------------------------------------------------------------------ GET driver-status
  app.get('/api/finance/driver-status', authenticateToken, async (req, res) => {
    try {
      if (!(await readGate(req, res))) return;
      const b = await consolidated();
      const canEdit = await kit.can(req, PERM_EDIT);
      const canApprove = canEdit && await kit.can(req, PERM_APPROVE);
      if (!b) return res.json({ empty: true, fiscalYear: FY });
      const locked = b.status === 'approved';
      const c = await loadCtx(b);
      res.json({
        budget: budgetOut(b), locked,
        caps: { canEdit: canEdit && !locked, canApprove: canApprove && !locked },
        lines: c.lines, directory: c.directory, summary: c.summary,
      });
    } catch (e) { fail(res, e, 'driver-status'); }
  });

  // ------------------------------------------------------------------------ clés et attentes
  function readKeys(body, ctx) {
    const known = new Set(ctx.lines.map((l) => l.key));
    return C.cleanKeys(body && body.keys, known);
  }
  // expect : { clé: { version?, hash? } } ; les clés qui ont bougé depuis que l'écran les a lues.
  function conflictsOf(expect, keys, byKey) {
    if (!expect || typeof expect !== 'object' || Array.isArray(expect)) return [];
    const out = [];
    for (const k of keys) {
      const e = expect[k];
      if (!e || typeof e !== 'object') continue;
      const l = byKey.get(k);
      if ((e.hash !== undefined && e.hash !== l.hash) || (e.version !== undefined && e.version !== l.version)) out.push(k);
    }
    return out;
  }
  const expVersion = (expect, k) => {
    const e = expect && typeof expect === 'object' && expect[k];
    return e && Number.isInteger(e.version) ? e.version : null;
  };
  const logIt = (b, event, description, email, metadata) =>
    logActivity('finance_driver_status', String(b.id), event, description, email, { metadata });

  // ------------------------------------------------------------------------ submit / approve / reopen
  const SQL = {
    submitted: `
      INSERT INTO finance_driver_status (budget_id, key, status, submitted_hash, submitted_by, submitted_at, updated_by, updated_at, version)
      VALUES ($1, $2, 'submitted', $3, $4, NOW(), $4, NOW(), 1)
      ON CONFLICT (budget_id, key) DO UPDATE SET status = 'submitted', submitted_hash = EXCLUDED.submitted_hash,
        submitted_by = EXCLUDED.submitted_by, submitted_at = NOW(), updated_by = EXCLUDED.updated_by, updated_at = NOW(),
        version = finance_driver_status.version + 1
      WHERE ($5::int IS NULL OR finance_driver_status.version = $5::int)
      RETURNING version`,
    approved: `
      INSERT INTO finance_driver_status (budget_id, key, status, approved_hash, approved_by, approved_at, updated_by, updated_at, version)
      VALUES ($1, $2, 'approved', $3, $4, NOW(), $4, NOW(), 1)
      ON CONFLICT (budget_id, key) DO UPDATE SET status = 'approved', approved_hash = EXCLUDED.approved_hash,
        approved_by = EXCLUDED.approved_by, approved_at = NOW(), updated_by = EXCLUDED.updated_by, updated_at = NOW(),
        version = finance_driver_status.version + 1
      WHERE ($5::int IS NULL OR finance_driver_status.version = $5::int)
      RETURNING version`,
    reopen: `
      UPDATE finance_driver_status SET status = 'proposed', approved_hash = NULL, approved_by = NULL, approved_at = NULL,
        submitted_hash = NULL, submitted_by = NULL, submitted_at = NULL, updated_by = $3, updated_at = NOW(), version = version + 1
      WHERE budget_id = $1 AND key = $2 AND ($4::int IS NULL OR version = $4::int)
      RETURNING version`,
  };

  for (const action of ['submit', 'approve', 'reopen']) {
    app.post(`/api/finance/driver-status/${action}`, authenticateToken, async (req, res) => {
      try {
        const b = await writeGate(req, res, { approve: action !== 'submit' });
        if (!b) return;
        const body = req.body || {};
        let reason = null;
        if (action === 'reopen') {
          reason = typeof body.reason === 'string' ? body.reason.replace(/\s+/g, ' ').trim() : '';
          if (reason.length < 3 || reason.length > REASON_MAX) return res.status(400).json({ error: 'bad_reason' });
        }
        const ctx = await loadCtx(b);
        const k = readKeys(body, ctx);
        if (k.error) return res.status(400).json({ error: k.error, ...(k.key ? { key: k.key } : {}) });
        const byKey = new Map(ctx.lines.map((l) => [l.key, l]));
        const stale = conflictsOf(body.expect, k.keys, byKey);
        if (stale.length) return res.status(409).json({ error: 'conflict', keys: stale });

        const email = req.user.email;
        const changed = [], skipped = [], conflicts = [];
        for (const key of k.keys) {
          const l = byKey.get(key);
          if (action === 'submit' && l.state === 'approved') { skipped.push({ key, reason: 'already_approved' }); continue; }
          if (action === 'submit' && l.state === 'submitted') { skipped.push({ key, reason: 'already_submitted' }); continue; }
          if (action === 'approve' && l.state === 'approved') { skipped.push({ key, reason: 'already_approved' }); continue; }
          if (action === 'reopen' && !['approved', 'stale', 'submitted'].includes(l.state)) { skipped.push({ key, reason: 'not_reopenable' }); continue; }
          const ev = expVersion(body.expect, key);
          const r = action === 'reopen'
            ? await pool.query(SQL.reopen, [b.id, key, email, ev])
            : await pool.query(action === 'approve' ? SQL.approved : SQL.submitted, [b.id, key, l.hash, email, ev]);
          if (r.rows[0]) changed.push(key); else conflicts.push(key);
        }
        if (changed.length) {
          await logIt(b, { submit: 'submitted', approve: 'approved', reopen: 'reopened' }[action],
            `Budget ${b.fiscal_year} : ${changed.length} ligne(s) ${{ submit: 'soumise(s)', approve: 'approuvée(s)', reopen: 'rouverte(s)' }[action]}`,
            email, { count: changed.length, keys: changed.slice(0, LOG_KEYS), ...(reason ? { reason } : {}) });
        }
        const fresh = await loadCtx(b);
        const lines = fresh.lines.filter((x) => changed.includes(x.key));
        if (conflicts.length) return res.status(409).json({ error: 'conflict', keys: conflicts, changed, lines, summary: fresh.summary });
        res.json({ ok: true, changed, skipped, lines, summary: fresh.summary });
      } catch (e) {
        console.error(`finance driver-status ${action}:`, e.message);
        res.status(500).json({ error: 'save_failed' });
      }
    });
  }

  // ------------------------------------------------------------------------ responsables
  async function rememberOwners(names, email) {
    for (const name of names) {
      const has = await pool.query('SELECT 1 FROM finance_owner_directory WHERE name = $1', [name]);
      if (has.rows[0]) continue;
      const s = await pool.query('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM finance_owner_directory');
      await pool.query('INSERT INTO finance_owner_directory (name, sort, created_by) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING', [name, s.rows[0].s, email]);
    }
  }
  const OWNER_SQL = `
    INSERT INTO finance_driver_status (budget_id, key, owner, status, updated_by, updated_at, version)
    VALUES ($1, $2, $3, 'proposed', $4, NOW(), 1)
    ON CONFLICT (budget_id, key) DO UPDATE SET owner = EXCLUDED.owner, updated_by = EXCLUDED.updated_by, updated_at = NOW(),
      version = finance_driver_status.version + 1
    WHERE ($5::int IS NULL OR finance_driver_status.version = $5::int)
    RETURNING version`;

  async function setOwners(req, res, pick) {
    const b = await writeGate(req, res);
    if (!b) return;
    const body = req.body || {};
    const ctx = await loadCtx(b);
    const k = readKeys(body, ctx);
    if (k.error) return res.status(400).json({ error: k.error, ...(k.key ? { key: k.key } : {}) });
    const byKey = new Map(ctx.lines.map((l) => [l.key, l]));
    const plan = pick(body, k.keys, byKey); // [{ key, owner|null }] ou { error }
    if (plan.error) return res.status(400).json({ error: plan.error });
    const stale = conflictsOf(body.expect, k.keys, byKey);
    if (stale.length) return res.status(409).json({ error: 'conflict', keys: stale });
    const email = req.user.email;
    const changed = [], conflicts = [];
    for (const { key, owner } of plan.items) {
      const r = await pool.query(OWNER_SQL, [b.id, key, owner, email, expVersion(body.expect, key)]);
      if (r.rows[0]) changed.push(key); else conflicts.push(key);
    }
    await rememberOwners([...new Set(plan.items.map((p) => p.owner).filter(Boolean))], email);
    if (changed.length) {
      await logIt(b, plan.event, `Budget ${b.fiscal_year} : responsable ${plan.event === 'owners_confirmed' ? 'suggéré confirmé' : 'modifié'} sur ${changed.length} ligne(s)`,
        email, { count: changed.length, keys: changed.slice(0, LOG_KEYS), ...(plan.owner !== undefined ? { owner: plan.owner } : {}) });
    }
    const fresh = await loadCtx(b);
    const lines = fresh.lines.filter((x) => changed.includes(x.key));
    const out = { changed, skipped: plan.skipped || [], lines, directory: fresh.directory, summary: fresh.summary };
    if (conflicts.length) return res.status(409).json({ error: 'conflict', keys: conflicts, ...out });
    res.json({ ok: true, ...out });
  }

  app.put('/api/finance/driver-status/owner', authenticateToken, async (req, res) => {
    try {
      await setOwners(req, res, (body, keys) => {
        let owner = null;
        if (body.owner !== null && body.owner !== '') {
          owner = C.cleanOwner(body.owner);
          if (!owner) return { error: 'bad_owner' };
        }
        return { event: 'owner_set', owner, items: keys.map((key) => ({ key, owner })) };
      });
    } catch (e) { console.error('finance driver-status owner:', e.message); res.status(500).json({ error: 'save_failed' }); }
  });

  // Confirmer en lot les responsables SUGGÉRÉS : seules les lignes sans responsable sont touchées.
  app.post('/api/finance/driver-status/owners/confirm', authenticateToken, async (req, res) => {
    try {
      await setOwners(req, res, (body, keys, byKey) => {
        const items = [], skipped = [];
        for (const key of keys) {
          const l = byKey.get(key);
          if (l.owner) skipped.push({ key, reason: 'has_owner' });
          else items.push({ key, owner: l.suggestedOwner });
        }
        return { event: 'owners_confirmed', items, skipped };
      });
    } catch (e) { console.error('finance driver-status owners confirm:', e.message); res.status(500).json({ error: 'save_failed' }); }
  });

  // Annuaire des responsables (liste de suggestions, modifiable par la CFO).
  app.post('/api/finance/driver-status/directory', authenticateToken, async (req, res) => {
    try {
      if (!(await kit.guardAll(req, res, [PERM_VIEW, PERM_EDIT]))) return;
      await ensure();
      const name = C.cleanOwner(req.body && req.body.name);
      if (!name) return res.status(400).json({ error: 'bad_owner' });
      await rememberOwners([name], req.user.email);
      await logActivity('finance_driver_status', 'directory', 'directory_added', `Responsable ajouté à l'annuaire : ${name}`, req.user.email, { metadata: { name } });
      const dir = await pool.query('SELECT name FROM finance_owner_directory ORDER BY sort, name');
      res.json({ ok: true, directory: dir.rows.map((r) => r.name) });
    } catch (e) { console.error('finance directory add:', e.message); res.status(500).json({ error: 'save_failed' }); }
  });
  app.delete('/api/finance/driver-status/directory/:name', authenticateToken, async (req, res) => {
    try {
      if (!(await kit.guardAll(req, res, [PERM_VIEW, PERM_EDIT]))) return;
      await ensure();
      const name = C.cleanOwner(req.params.name);
      if (!name) return res.status(400).json({ error: 'bad_owner' });
      const r = await pool.query('DELETE FROM finance_owner_directory WHERE name = $1 RETURNING name', [name]);
      if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
      // Les lignes déjà confiées à cette personne la gardent : on ne retire que la suggestion.
      await logActivity('finance_driver_status', 'directory', 'directory_removed', `Responsable retiré de l'annuaire : ${name}`, req.user.email, { metadata: { name } });
      const dir = await pool.query('SELECT name FROM finance_owner_directory ORDER BY sort, name');
      res.json({ ok: true, directory: dir.rows.map((x) => x.name) });
    } catch (e) { console.error('finance directory remove:', e.message); res.status(500).json({ error: 'save_failed' }); }
  });

  // ------------------------------------------------------------------------ progression
  const iso = (d) => (d ? new Date(d).toISOString() : null);

  // Un contrôle qui échoue (table pas encore créée, etc.) devient « à vérifier », jamais une erreur 500.
  async function safe(id, link, fn) {
    try { return C.makeItem(id, { link, ...(await fn()) }); }
    catch (e) { return C.makeItem(id, { state: 'warn', link, detail: { code: 'not_initialized' } }); }
  }
  const scalar = async (sql, params) => Number(((await pool.query(sql, params)).rows[0] || {}).c || 0);

  async function buildProgress(b) {
    const ctx = await loadCtx(b);
    const S = ctx.summary;
    const items = {};
    const add = async (id, link, fn) => { items[id] = await safe(id, link, fn); };

    const driversItem = (g) => () => {
      const t = S.groups[g];
      return {
        state: !t.total ? 'warn' : t.approved === t.total ? 'done' : 'todo', done: t.approved, total: t.total,
        detail: { code: t.total ? 'approved_of' : 'no_lines', approved: t.approved, total: t.total, stale: t.stale, submitted: t.submitted },
      };
    };
    await add('drivers_revenue', '/finance/revenue-drivers', driversItem('revenue'));
    await add('drivers_cogs', '/finance/cogs-drivers', driversItem('cogs'));
    await add('opex_lines', '/finance/opex', driversItem('opex'));
    await add('drivers_stale', '/finance/progress', () => ({
      state: S.stale ? 'warn' : 'done', done: S.approved, total: S.approved + S.stale,
      detail: { code: S.stale ? 'stale' : 'none_stale', stale: S.stale },
    }));
    await add('owners', '/finance/progress', () => ({
      state: S.ownersMissing ? 'todo' : S.total ? 'done' : 'warn', done: S.total - S.ownersMissing, total: S.total,
      detail: { code: 'owners', missing: S.ownersMissing, total: S.total },
    }));

    await add('roster', '/finance/payroll', async () => {
      const e = await scalar('SELECT COUNT(*) AS c FROM finance_employees WHERE budget_id = $1', [b.id]);
      const c = await scalar('SELECT COUNT(*) AS c FROM finance_contractors WHERE budget_id = $1', [b.id]);
      const done = (e > 0 ? 1 : 0) + (c > 0 ? 1 : 0);
      return { state: done === 2 ? 'done' : done === 1 ? 'warn' : 'todo', done, total: 2, detail: { code: 'roster', employees: e, contractors: c } };
    });
    await add('opex_base', '/finance/opex', () => {
      const lines = (b.reference.opex || []).filter((it) => it.t === 'line' && Array.isArray(it.v) && it.v.length >= 24).length;
      return { state: lines ? 'done' : 'todo', done: lines ? 1 : 0, total: 1, detail: { code: 'opex_base', lines } };
    });
    await add('payroll_settings', '/finance/payroll', async () => {
      const r = await pool.query("SELECT 1 FROM finance_state WHERE budget_id = $1 AND section = 'payroll'", [b.id]);
      return { state: r.rows[0] ? 'done' : 'todo', done: r.rows[0] ? 1 : 0, total: 1, detail: { code: r.rows[0] ? 'payroll_saved' : 'payroll_defaults' } };
    });
    await add('kpi_budget', '/finance/kpi', async () => {
      const r = await pool.query(`SELECT COUNT(DISTINCT to_char(month, 'YYYY-MM')) AS c FROM finance_kpi_budget WHERE month >= '${FY}-01-01'::date AND month <= '${FY}-12-01'::date`);
      const done = Number(r.rows[0].c || 0);
      return { state: done >= 12 ? 'done' : 'todo', done, total: 12, detail: { code: 'kpi_months', done, missing: 12 - done } };
    });

    const syncRow = async (source) => (await pool.query('SELECT state, last_ok_at FROM finance_kpi_sync_status WHERE source = $1', [source])).rows[0] || null;
    await add('billing_sync', '/finance/kpi', async () => {
      const r = await syncRow('zoho');
      if (!r) return { state: 'todo', detail: { code: 'never' } };
      if (r.state === 'ok') return { state: 'done', done: 1, total: 1, detail: { code: 'synced', at: iso(r.last_ok_at) } };
      return { state: 'warn', detail: { code: r.state === 'busy' ? 'busy' : 'error', at: iso(r.last_ok_at) } };
    });
    let booksBlocked = false;
    await add('books_connected', '/finance/kpi', async () => {
      const r = await syncRow('books');
      if (!r) return { state: 'todo', detail: { code: 'never' } };
      if (r.state === 'ok') return { state: 'done', done: 1, total: 1, detail: { code: 'synced', at: iso(r.last_ok_at) } };
      if (r.state === 'reconnect') { booksBlocked = true; return { state: 'blocked', detail: { code: 'reconnect' } }; }
      return { state: 'warn', detail: { code: 'error', at: iso(r.last_ok_at) } };
    });
    await add('gl_actuals', '/finance/kpi', async () => {
      const months = await scalar("SELECT COUNT(DISTINCT month) AS c FROM finance_gl_monthly WHERE source = 'books'");
      if (months > 0) return { state: 'done', done: months, total: 0, detail: { code: 'gl_months', months } };
      return { state: booksBlocked ? 'blocked' : 'todo', detail: { code: booksBlocked ? 'no_actuals_blocked' : 'no_actuals' } };
    });
    await add('forecasts', '/finance/sales-forecast', async () => {
      const r = await pool.query("SELECT COUNT(*) AS c FROM finance_fc_docs WHERE doc_key IN ('sales', 'payments', 'cash')");
      const done = Number(r.rows[0].c || 0);
      return { state: done >= 3 ? 'done' : 'todo', done, total: 3, detail: { code: 'forecast_docs', done, total: 3 } };
    });
    await add('managers_deferred', '/finance/deferred-revenue', async () => {
      const c = await scalar('SELECT COUNT(*) AS c FROM finance_deferred_contracts');
      return { state: c ? 'done' : 'todo', done: c ? 1 : 0, total: 1, detail: { code: 'rows', count: c } };
    });
    await add('managers_amort', '/finance/terminal-amortization', async () => {
      const c = await scalar('SELECT COUNT(*) AS c FROM finance_amort_lots');
      return { state: c ? 'done' : 'todo', done: c ? 1 : 0, total: 1, detail: { code: 'rows', count: c } };
    });
    const entityLinks = { budget_cluster: '/finance/cluster-budget', budget_xperio: '/finance/xperio-budget', budget_departments: '/finance/departmental-budgets' };
    for (const [id, entity] of Object.entries(ENTITY_ROWS)) {
      await add(id, entityLinks[id], async () => {
        const r = await pool.query('SELECT status FROM finance_budgets WHERE fiscal_year = $1 AND entity = $2', [FY, entity]);
        if (!r.rows[0]) return { state: 'todo', done: 0, total: 1, detail: { code: 'not_imported' } };
        const ok = r.rows[0].status === 'approved';
        return { state: ok ? 'done' : 'todo', done: ok ? 1 : 0, total: 1, detail: { code: ok ? 'approved' : 'draft' } };
      });
    }

    // L'approbation finale : dernier point, selon les autres.
    const ordered = () => C.ITEM_DEFS.filter((d) => items[d.id]).map((d) => items[d.id]);
    const pre = C.finalizeProgress(ordered());
    const remaining = pre.requiredTotal - pre.requiredDone;
    const approved = b.status === 'approved';
    await add('final_approval', '/finance', () => ({
      state: approved ? 'done' : 'todo', done: approved ? 1 : 0, total: 1,
      detail: approved ? { code: 'final_approved', at: iso(b.approved_at) } : { code: remaining ? 'not_ready' : 'ready_to_approve', remaining },
    }));
    const list = ordered();
    return { items: list, ...C.finalizeProgress(list), summary: S };
  }

  app.get('/api/finance/progress', authenticateToken, async (req, res) => {
    try {
      if (!(await kit.guardAll(req, res, [PERM_VIEW, PERM_PROGRESS]))) return;
      await ensure();
      const b = await consolidated();
      if (!b) return res.json({ empty: true, fiscalYear: FY, items: [], ready: false, percent: 0 });
      const p = await buildProgress(b);
      res.json({
        budget: budgetOut(b), fiscalYear: FY, generatedAt: new Date().toISOString(),
        caps: { canEdit: await kit.can(req, PERM_EDIT), canApprove: await kit.can(req, PERM_APPROVE) },
        ...p,
      });
    } catch (e) { fail(res, e, 'progress'); }
  });
}

module.exports = { register, ensureSchema };
