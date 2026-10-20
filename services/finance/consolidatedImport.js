// ============================================================================
// Module Finance — import Excel du budget CONSOLIDÉ FY2027 depuis l'application (la CFO recharge
// ses propres classeurs ; avant, seul un script ponctuel du paquet de passation le faisait).
//
//   Effectif (Salaires & contractuels), perms finance:edit + finance:payroll :
//     GET  /api/finance/consolidated/roster/template      modèle .xlsx rempli avec l'effectif actuel
//     POST /api/finance/consolidated/roster/preview       (multipart « file ») → APERÇU, n'écrit RIEN
//     POST /api/finance/consolidated/roster/confirm       { token, base, removeMissing } → applique
//   OPEX (lignes de base de la référence), perm finance:edit :
//     GET  /api/finance/consolidated/opex/template
//     POST /api/finance/consolidated/opex/preview
//     POST /api/finance/consolidated/opex/confirm         { token, base }
//
// Règles : aperçu puis confirmation ; le jeton (SHA-256 de la charge utile lue + usager + budget) est
// gardé EN MÉMOIRE 1 h, lié à l'usager, et ne sert qu'une fois (si le serveur redémarre entre les
// deux, on redemande le fichier : 410 `token_expired`). Tout s'écrit dans UNE transaction, sous
// verrou de la ligne du budget ; une base périmée (quelqu'un a modifié l'effectif / la référence
// entre-temps) donne 409 `conflict`, un budget approuvé 409 `locked`. Rien ne s'efface sans
// `removeMissing`. Les personnes gardent leur identifiant, leurs surcharges (hausse, charges) et
// leurs mois d'arrivée / de départ ; `salary_base` / `amt_base` prennent la valeur importée (donc
// « Réinitialiser la paie » revient au dernier import).
// ============================================================================

const X = require('./consolidatedXlsx');

const FY = 2027;
const PERM_EDIT = 'finance:edit';
const PERM_PAYROLL = 'finance:payroll';
const TOKEN_TTL_MS = 60 * 60 * 1000;
const MAX_TOKENS = 200;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = Number(process.env.FINANCE_IMPORT_RATE_MAX) || 60;
const DEFAULT_PAYROLL = { burden: 17.5, raise: 0, raiseMo: 0 };

const n = (v) => (v == null ? null : Number(v));
const empOut = (r) => ({
  id: r.id, ent: r.ent, dept: r.dept, name: r.name, salary: n(r.salary), alloc: n(r.alloc), map: r.map,
  raisePct: n(r.raise_pct), raiseMo: r.raise_mo, burdenPct: n(r.burden_pct), startMo: r.start_mo, endMo: r.end_mo,
});
const conOut = (r) => ({
  id: r.id, co: r.co, name: r.name, svc: r.svc, rate: n(r.rate), hours: n(r.hours), amt: n(r.amt),
  map: r.map, dept: r.dept, startMo: r.start_mo, endMo: r.end_mo,
});

async function withTx(pool, fn) {
  const client = pool.connect ? await pool.connect() : null;
  const db = client || pool;
  try {
    await db.query('BEGIN');
    try {
      const out = await fn(db);
      await db.query('COMMIT');
      return out;
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  } finally {
    if (client) client.release();
  }
}

function register(app, kit) {
  const { pool, authenticateToken, logActivity } = kit;
  const tokens = new Map(); // jeton → { user, kind, budgetId, base, payload, file, exp }
  const hits = new Map(); // usager → [horodatages]

  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of tokens) if (v.exp < now) tokens.delete(k);
    while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value);
  };
  const limited = (email) => {
    const now = Date.now();
    const a = (hits.get(email) || []).filter((t) => now - t < RATE_WINDOW_MS);
    a.push(now);
    hits.set(email, a);
    return a.length > RATE_MAX;
  };
  const sendXlsx = (res, name, buf) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buf);
  };

  // Budget consolidé FY2027, modifiable ; sinon la réponse est déjà envoyée.
  async function openBudget(req, res, perms) {
    if (!(await kit.guardAll(req, res, perms))) return null;
    if (limited(req.user.email)) { res.status(429).json({ error: 'rate_limited' }); return null; }
    const r = await pool.query("SELECT * FROM finance_budgets WHERE fiscal_year = $1 AND entity = 'consolidated'", [FY]);
    const b = r.rows[0];
    if (!b) { res.status(404).json({ error: 'no_budget' }); return null; }
    if (b.status === 'approved') { res.status(409).json({ error: 'locked', approvedBy: b.approved_by, approvedAt: b.approved_at }); return null; }
    return b;
  }

  // Le fichier (multipart « file »), lu APRÈS la garde d'accès : un usager sans droit n'envoie rien.
  async function readFile(req, res) {
    if (!kit.upload) { res.status(501).json({ error: 'upload_unavailable' }); return null; }
    const err = await new Promise((resolve) => kit.upload(req, res, resolve));
    if (err) { res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'bad_upload' }); return null; }
    const f = req.file;
    if (!f || !f.buffer || !f.buffer.length) { res.status(400).json({ error: 'no_file' }); return null; }
    if (!/\.xlsx$/i.test(f.originalname || '') || !X.isXlsxBuffer(f.buffer)) { res.status(400).json({ error: 'not_xlsx' }); return null; }
    return f;
  }

  const openError = (res, e) => {
    const code = e && e.code;
    if (['not_xlsx', 'unreadable', 'file_too_large', 'xlsx_unavailable'].includes(code)) {
      res.status(code === 'xlsx_unavailable' ? 501 : 400).json({ error: code });
      return true;
    }
    return false;
  };

  const loadRoster = async (db, id, lock = '') => {
    const [e, c] = await Promise.all([
      db.query(`SELECT * FROM finance_employees WHERE budget_id = $1 ORDER BY sort, id ${lock}`, [id]),
      db.query(`SELECT * FROM finance_contractors WHERE budget_id = $1 ORDER BY sort, id ${lock}`, [id]),
    ]);
    return { employees: e.rows.map(empOut), contractors: c.rows.map(conOut) };
  };
  const loadGlobals = async (db, id) => {
    const r = await db.query("SELECT data FROM finance_state WHERE budget_id = $1 AND section = 'payroll'", [id]);
    return { ...DEFAULT_PAYROLL, ...((r.rows[0] && r.rows[0].data) || {}) };
  };

  const issue = (user, kind, b, base, payload, file) => {
    sweep();
    const token = X.sha256(JSON.stringify({ user, kind, budget: b.id, payload }));
    tokens.set(token, { user, kind, budgetId: b.id, base, payload, file, exp: Date.now() + TOKEN_TTL_MS });
    return token;
  };
  // Jeton valide (même usager, même genre, pas expiré) ; sinon la réponse est envoyée.
  const takeToken = (req, res, kind) => {
    const t = req.body && typeof req.body.token === 'string' ? req.body.token : '';
    const e = tokens.get(t);
    if (!e || e.exp < Date.now() || e.kind !== kind) { res.status(410).json({ error: 'token_expired' }); return null; }
    if (e.user !== req.user.email) { res.status(403).json({ error: 'token_forbidden' }); return null; }
    return { token: t, ...e };
  };

  // ======================================================================== effectif
  const rosterPerms = [PERM_EDIT, PERM_PAYROLL];

  app.get('/api/finance/consolidated/roster/template', authenticateToken, async (req, res) => {
    try {
      const b = await openBudget(req, res, rosterPerms);
      if (!b) return;
      const cur = await loadRoster(pool, b.id);
      const globals = await loadGlobals(pool, b.id);
      sendXlsx(res, `salary & contractors - FY${FY}.xlsx`, X.rosterTemplate(cur, globals, req.query.lang === 'fr' ? 'fr' : 'en'));
    } catch (e) {
      console.error('finance roster template:', e.message);
      res.status(500).json({ error: 'template_failed' });
    }
  });

  const personOut = (kind, x) => (kind === 'employee'
    ? { ent: x.ent, dept: x.dept, name: x.name, salary: x.salary, alloc: x.alloc, map: x.map }
    : { co: x.co, name: x.name, svc: x.svc, rate: x.rate, hours: x.hours, amt: x.amt, map: x.map, dept: x.dept });

  app.post('/api/finance/consolidated/roster/preview', authenticateToken, async (req, res) => {
    try {
      const b = await openBudget(req, res, rosterPerms);
      if (!b) return;
      const f = await readFile(req, res);
      if (!f) return;
      let parsed;
      try { parsed = X.parseRoster(f.buffer); } catch (e) { if (openError(res, e)) return; throw e; }
      if (parsed.errors.some((x) => x.code === 'no_roster_tables')) return res.status(400).json({ error: 'invalid_workbook', errors: parsed.errors, warnings: parsed.warnings });
      const cur = await loadRoster(pool, b.id);
      const globals = await loadGlobals(pool, b.id);
      const base = X.rosterFingerprint(cur, globals);
      const d = X.diffRoster(cur, parsed);
      const warnings = [...parsed.warnings];
      const side = (kind, k) => (d[k] ? {
        compared: true,
        added: d[k].added.map((x) => personOut(kind, x)),
        changed: d[k].changed.map((x) => ({ ...personOut(kind, x.file), id: x.id, changes: x.changes })),
        missing: d[k].missing.map((x) => ({ id: x.id, ...personOut(kind, x) })),
        unchanged: d[k].unchanged.length,
      } : { compared: false, added: [], changed: [], missing: [], unchanged: 0 });
      const employees = side('employee', 'employees'), contractors = side('contractor', 'contractors');
      const before = X.payrollTotals(cur.employees, cur.contractors, globals);
      const after = X.rosterAfter(cur, d, false);
      const afterRemove = X.rosterAfter(cur, d, true);
      const totals = {
        before,
        after: X.payrollTotals(after.employees, after.contractors, globals),
        afterRemoveMissing: X.payrollTotals(afterRemove.employees, afterRemove.contractors, globals),
      };
      const canConfirm = parsed.errors.length === 0;
      let token = null;
      if (canConfirm) {
        const payload = { employees: parsed.hasEmployees ? parsed.employees : null, contractors: parsed.hasContractors ? parsed.contractors : null };
        token = issue(req.user.email, 'roster', b, base, payload, f.originalname || null);
      }
      res.json({
        preview: {
          token, base, canConfirm, file: f.originalname || null, sheets: parsed.sheets,
          employees, contractors, totals, errors: parsed.errors, warnings,
        },
      });
    } catch (e) {
      console.error('finance roster preview:', e.message);
      res.status(500).json({ error: 'import_failed' });
    }
  });

  app.post('/api/finance/consolidated/roster/confirm', authenticateToken, async (req, res) => {
    try {
      const b0 = await openBudget(req, res, rosterPerms);
      if (!b0) return;
      const tk = takeToken(req, res, 'roster');
      if (!tk) return;
      if (tk.budgetId !== b0.id) return res.status(410).json({ error: 'token_expired' });
      const removeMissing = !!(req.body && req.body.removeMissing);
      const email = req.user.email;
      const out = await withTx(pool, async (db) => {
        // Verrou de la ligne du budget : un autre import ou une approbation attend ici.
        const lk = await db.query('SELECT status, approved_by, approved_at FROM finance_budgets WHERE id = $1 FOR UPDATE', [b0.id]);
        const row = lk.rows[0];
        if (!row) return { status: 404, body: { error: 'no_budget' } };
        if (row.status === 'approved') return { status: 409, body: { error: 'locked', approvedBy: row.approved_by, approvedAt: row.approved_at } };
        const cur = await loadRoster(db, b0.id, '');
        const globals = await loadGlobals(db, b0.id);
        const now = X.rosterFingerprint(cur, globals);
        if (now !== tk.base || (req.body.base || null) !== now) return { status: 409, body: { error: 'conflict' } };
        const p = tk.payload;
        const d = X.diffRoster(cur, { hasEmployees: !!p.employees, hasContractors: !!p.contractors, employees: p.employees || [], contractors: p.contractors || [] });
        const done = { employees: { added: 0, changed: 0, removed: 0 }, contractors: { added: 0, changed: 0, removed: 0 } };
        if (d.employees) {
          for (const x of d.employees.pairs) {
            await db.query(
              'UPDATE finance_employees SET salary = $3, salary_base = $3, alloc = $4, map = $5, dept = $6, updated_at = NOW() WHERE id = $1 AND budget_id = $2',
              [x.cur.id, b0.id, x.file.salary, x.file.alloc, x.file.map, x.file.dept]);
          }
          done.employees.changed = d.employees.changed.length;
          const s = await db.query('SELECT COALESCE(MAX(sort), 0) AS s FROM finance_employees WHERE budget_id = $1', [b0.id]);
          let sort = Number(s.rows[0].s);
          for (const a of d.employees.added) {
            await db.query(
              `INSERT INTO finance_employees (budget_id, ent, dept, name, salary, salary_base, alloc, map, sort, created_by)
               VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)`,
              [b0.id, a.ent, a.dept, a.name, a.salary, a.alloc, a.map, ++sort, email]);
          }
          done.employees.added = d.employees.added.length;
          if (removeMissing && d.employees.missing.length) {
            await db.query('DELETE FROM finance_employees WHERE budget_id = $1 AND id = ANY($2::int[])', [b0.id, d.employees.missing.map((m) => m.id)]);
            done.employees.removed = d.employees.missing.length;
          }
        }
        if (d.contractors) {
          for (const x of d.contractors.pairs) {
            const f = x.file;
            await db.query(
              `UPDATE finance_contractors SET amt = $3, amt_base = $3, rate = $4, hours = $5, map = $6, svc = $7,
                 dept = CASE WHEN $9 THEN $8 ELSE dept END, updated_at = NOW() WHERE id = $1 AND budget_id = $2`,
              [x.cur.id, b0.id, f.amt, f.rate || null, f.hours || null, f.map, f.svc, f.dept, !!f.deptFromFile]);
          }
          done.contractors.changed = d.contractors.changed.length;
          const s = await db.query('SELECT COALESCE(MAX(sort), 0) AS s FROM finance_contractors WHERE budget_id = $1', [b0.id]);
          let sort = Number(s.rows[0].s);
          for (const a of d.contractors.added) {
            await db.query(
              `INSERT INTO finance_contractors (budget_id, co, name, svc, rate, hours, amt, amt_base, map, dept, sort, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11)`,
              [b0.id, a.co, a.name, a.svc, a.rate || null, a.hours || null, a.amt, a.map, a.dept || '', ++sort, email]);
          }
          done.contractors.added = d.contractors.added.length;
          if (removeMissing && d.contractors.missing.length) {
            await db.query('DELETE FROM finance_contractors WHERE budget_id = $1 AND id = ANY($2::int[])', [b0.id, d.contractors.missing.map((m) => m.id)]);
            done.contractors.removed = d.contractors.missing.length;
          }
        }
        await db.query('UPDATE finance_budgets SET updated_at = NOW() WHERE id = $1', [b0.id]);
        return { status: 200, body: { applied: done } };
      });
      if (out.status !== 200) return res.status(out.status).json(out.body);
      tokens.delete(tk.token); // un jeton ne sert qu'une fois
      const a = out.body.applied;
      await logActivity('finance_budget', String(b0.id), 'roster_imported',
        `Budget ${FY} : effectif importé (${a.employees.added + a.contractors.added} ajouté(s), ${a.employees.changed + a.contractors.changed} modifié(s), ${a.employees.removed + a.contractors.removed} retiré(s))`,
        email, { metadata: { file: tk.file, removeMissing, applied: a } });
      const cur = await loadRoster(pool, b0.id);
      const globals = await loadGlobals(pool, b0.id);
      res.json({ applied: a, totals: X.payrollTotals(cur.employees, cur.contractors, globals) });
    } catch (e) {
      console.error('finance roster confirm:', e.message);
      res.status(500).json({ error: 'import_failed' });
    }
  });

  // ======================================================================== OPEX
  app.get('/api/finance/consolidated/opex/template', authenticateToken, async (req, res) => {
    try {
      const b = await openBudget(req, res, [PERM_EDIT]);
      if (!b) return;
      sendXlsx(res, `opex - FY${FY}.xlsx`, X.opexTemplate(b.reference));
    } catch (e) {
      console.error('finance opex template:', e.message);
      res.status(500).json({ error: 'template_failed' });
    }
  });

  // Lignes pour lesquelles la CFO a saisi des cellules ou une hausse dans l'app : ces ajustements
  // PRIMENT sur la base importée (FY2027).
  async function overriddenKeys(db, id) {
    const r = await db.query("SELECT data FROM finance_state WHERE budget_id = $1 AND section = 'opex'", [id]);
    const d = (r.rows[0] && r.rows[0].data) || {};
    return new Set([...Object.keys(d.opx || {}), ...Object.entries(d.opxG || {}).filter(([, g]) => g).map(([k]) => k)]);
  }

  app.post('/api/finance/consolidated/opex/preview', authenticateToken, async (req, res) => {
    try {
      const b = await openBudget(req, res, [PERM_EDIT]);
      if (!b) return;
      const f = await readFile(req, res);
      if (!f) return;
      let parsed;
      try { parsed = X.parseOpex(f.buffer); } catch (e) { if (openError(res, e)) return; throw e; }
      if (parsed.errors.some((x) => x.code === 'no_opex_table' || x.code === 'bad_months')) return res.status(400).json({ error: 'invalid_workbook', errors: parsed.errors, warnings: parsed.warnings });
      const d = X.diffOpex(b.reference, parsed);
      const base = X.opexFingerprint(b.reference);
      const over = await overriddenKeys(pool, b.id);
      const warnings = [...parsed.warnings, ...d.warnings];
      const overridden = d.changed.filter((c) => !c.special && over.has(c.key) && c.after[1] !== c.before[1]).map((c) => c.name);
      if (overridden.length) warnings.push({ sheet: null, row: 0, code: 'fy27_adjustments_win', value: overridden.join(', ') });
      const special = d.changed.filter((c) => c.special);
      if (special.length) warnings.push({ sheet: null, row: 0, code: 'computed_lines', value: special.map((c) => c.name).join(', ') });
      const canConfirm = parsed.errors.length === 0;
      const lineOut = (c) => ({ key: c.key, name: c.name, section: c.section, special: c.special, months: c.months, fy: [0, 1, 2].map((i) => ({ before: c.before[i], after: c.after[i] })) });
      const payload = { changed: d.changed.map((c) => ({ key: c.key, values: c.values })) };
      const token = canConfirm ? issue(req.user.email, 'opex', b, base, payload, f.originalname || null) : null;
      res.json({
        preview: {
          token, base, canConfirm, file: f.originalname || null, sheet: parsed.sheet,
          changed: d.changed.map(lineOut), unchanged: d.unchanged.length,
          unmatched: d.unmatched, notInFile: d.notInFile,
          totals: {
            before: d.totals.before, after: d.totals.after,
            fy27Editable: d.totals.editableFy27,
          },
          errors: parsed.errors, warnings,
        },
      });
    } catch (e) {
      console.error('finance opex preview:', e.message);
      res.status(500).json({ error: 'import_failed' });
    }
  });

  app.post('/api/finance/consolidated/opex/confirm', authenticateToken, async (req, res) => {
    try {
      const b0 = await openBudget(req, res, [PERM_EDIT]);
      if (!b0) return;
      const tk = takeToken(req, res, 'opex');
      if (!tk) return;
      if (tk.budgetId !== b0.id) return res.status(410).json({ error: 'token_expired' });
      const email = req.user.email;
      const out = await withTx(pool, async (db) => {
        const lk = await db.query('SELECT status, approved_by, approved_at, reference FROM finance_budgets WHERE id = $1 FOR UPDATE', [b0.id]);
        const row = lk.rows[0];
        if (!row) return { status: 404, body: { error: 'no_budget' } };
        if (row.status === 'approved') return { status: 409, body: { error: 'locked', approvedBy: row.approved_by, approvedAt: row.approved_at } };
        const now = X.opexFingerprint(row.reference);
        if (now !== tk.base || (req.body.base || null) !== now) return { status: 409, body: { error: 'conflict' } };
        // Seules les valeurs `v` des lignes DÉJÀ présentes changent : clés, mappes de paie et structure intacts.
        const keys = new Set(row.reference.opex.filter((it) => it.t === 'line').map((it) => it.key));
        const changed = tk.payload.changed.filter((c) => keys.has(c.key));
        const ref = X.applyOpex(row.reference, { changed });
        await db.query('UPDATE finance_budgets SET reference = $2::jsonb, imported_by = $3, imported_at = NOW(), updated_at = NOW() WHERE id = $1',
          [b0.id, JSON.stringify(ref), email]);
        return { status: 200, body: { applied: { lines: changed.length } } };
      });
      if (out.status !== 200) return res.status(out.status).json(out.body);
      tokens.delete(tk.token);
      await logActivity('finance_budget', String(b0.id), 'opex_imported',
        `Budget ${FY} : base OPEX importée (${out.body.applied.lines} ligne(s) modifiée(s))`, email,
        { metadata: { file: tk.file, lines: tk.payload.changed.map((c) => c.key) } });
      res.json(out.body);
    } catch (e) {
      console.error('finance opex confirm:', e.message);
      res.status(500).json({ error: 'import_failed' });
    }
  });
}

module.exports = { register };
