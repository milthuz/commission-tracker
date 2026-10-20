// ============================================================================
// Module Finance — gestionnaires (lot D) : Revenus reportés et Amortissement des terminaux,
// et le passage de leurs écritures de journal dans Zoho Books.
//
// Chargé par routes.js (SUBMODULES) : register(app, kit). Le calcul est dans
// managersEngine.js (cents entiers), la validation et l'Excel dans managersXlsx.js, Zoho
// Books dans managersBooks.js.
//
// Données : saisie par la CFO (fenêtres) et import Excel (aperçu → confirmation). Aucune
// donnée d'exemple, aucun « rembourrage » de portefeuille (le prototype en ajoutait).
//
// Permissions (lecture = finance:view + la permission du module ; écriture = + finance:edit) :
//   finance:deferred      Revenus reportés
//   finance:amortization  Amortissement des terminaux
//   finance:post_je       Passer une écriture dans Zoho Books (avec la permission du module)
// Le mode démo est bloqué (kit.guard) : ce sont de vrais clients et de vrais montants.
//
// 🔑 Écritures IDEMPOTENTES : finance_journal_posts, une seule écriture vivante par
// (module, période, type) — index unique partiel « status <> 'voided' ». Une 2e écriture pour
// le même mois est refusée tant que la précédente n'a pas été marquée annulée (après l'avoir
// annulée / supprimée dans Books : Sales Hub n'a pas la portée de suppression).
// ============================================================================

const E = require('./managersEngine');
const X = require('./managersXlsx');
const { booksClient, BooksError } = require('./managersBooks');

const P = {
  VIEW: 'finance:view', EDIT: 'finance:edit', DEF: 'finance:deferred', AMORT: 'finance:amortization', POST: 'finance:post_je',
};
const MODULES = {
  deferred: { perm: P.DEF, entity: 'finance_deferred', kinds: ['recognition'], refPrefix: { recognition: 'SH-DEF' } },
  amortization: { perm: P.AMORT, entity: 'finance_amortization', kinds: ['amortization', 'writeoff'], refPrefix: { amortization: 'SH-AMO', writeoff: 'SH-WO' } },
};
const STUCK_MS = 5 * 60 * 1000;

// Libellés des lignes envoyées à Books (bilingues : la comptabilité lit les deux langues).
const ROLE_TEXT = {
  deferred: 'Deferred revenue / Revenus reportés',
  revenue: 'Revenue recognition / Constatation des revenus',
  amortExpense: 'Terminal amortization / Amortissement des terminaux',
  accumAmort: 'Accumulated amortization / Amortissement cumulé',
  writeOffLoss: 'Terminal write-off / Radiation de terminaux',
  terminalAsset: 'Terminals at cost / Terminaux au coût',
};
const KIND_TEXT = {
  recognition: 'Deferred revenue recognition / Constatation des revenus reportés',
  amortization: 'Terminal amortization / Amortissement des terminaux',
  writeoff: 'Terminal write-off / Radiation de terminaux',
};

async function ensureSchema(pool) {
  // Une instruction par appel (PGlite). Dates en TEXTE 'AAAA-MM(-JJ)' : jamais de colonne `date`
  // relue par String(date).slice(0, 10) (piège connu : l'année se perd).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_deferred_contracts (
      id              SERIAL PRIMARY KEY,
      ref             TEXT NOT NULL UNIQUE,
      customer        TEXT NOT NULL,
      type            TEXT NOT NULL,
      total           NUMERIC(14,2) NOT NULL,
      start_month     TEXT NOT NULL,
      term_months     INT NOT NULL,
      billed_date     TEXT,
      received_date   TEXT,
      closed_month    TEXT,
      close_treatment TEXT,
      close_reason    TEXT,
      notes           TEXT,
      source          TEXT NOT NULL DEFAULT 'manual',
      version         INT NOT NULL DEFAULT 1,
      created_by      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by      TEXT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_amort_lots (
      id                SERIAL PRIMARY KEY,
      ref               TEXT NOT NULL UNIQUE,
      description       TEXT NOT NULL,
      quantity          INT NOT NULL,
      unit_cost         NUMERIC(14,2) NOT NULL,
      in_service_month  TEXT NOT NULL,
      useful_life       INT NOT NULL DEFAULT 36,
      salvage           NUMERIC(14,2) NOT NULL DEFAULT 0,
      written_off_month TEXT,
      write_off_reason  TEXT,
      notes             TEXT,
      source            TEXT NOT NULL DEFAULT 'manual',
      version           INT NOT NULL DEFAULT 1,
      created_by        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by        TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Réglages (comptes, types de contrat), plan comptable Books en cache et correspondance
  // code → compte Books confirmée par la CFO.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_manager_settings (
      key         TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      version     INT NOT NULL DEFAULT 1,
      updated_by  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_journal_posts (
      id                 SERIAL PRIMARY KEY,
      module             TEXT NOT NULL,
      period             TEXT NOT NULL,
      kind               TEXT NOT NULL,
      lines              JSONB NOT NULL,
      lines_hash         TEXT NOT NULL,
      total              NUMERIC(14,2) NOT NULL,
      reference          TEXT,
      status             TEXT NOT NULL,
      books_journal_id   TEXT,
      books_entry_number TEXT,
      attempts           INT NOT NULL DEFAULT 1,
      posted_by          TEXT,
      posted_at          TIMESTAMPTZ,
      error              TEXT,
      voided_by          TEXT,
      voided_at          TIMESTAMPTZ,
      void_reason        TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS finance_journal_posts_live ON finance_journal_posts (module, period, kind) WHERE status <> 'voided'`);
}

// ---------------------------------------------------------------------------- lignes
const num = (v) => (v == null ? null : Number(v));
const contractOut = (r) => ({
  id: r.id, ref: r.ref, customer: r.customer, type: r.type, total: num(r.total), startMonth: r.start_month,
  termMonths: r.term_months, billedDate: r.billed_date, receivedDate: r.received_date, closedMonth: r.closed_month,
  closeTreatment: r.close_treatment, closeReason: r.close_reason, notes: r.notes, source: r.source,
  version: r.version, updatedBy: r.updated_by, updatedAt: r.updated_at,
});
const lotOut = (r) => ({
  id: r.id, ref: r.ref, description: r.description, quantity: r.quantity, unitCost: num(r.unit_cost),
  inServiceMonth: r.in_service_month, usefulLife: r.useful_life, salvage: num(r.salvage),
  writtenOffMonth: r.written_off_month, writeOffReason: r.write_off_reason, notes: r.notes, source: r.source,
  version: r.version, updatedBy: r.updated_by, updatedAt: r.updated_at,
});
const postOut = (r) => (r ? {
  id: r.id, module: r.module, period: r.period, kind: r.kind, lines: r.lines, hash: r.lines_hash, total: num(r.total),
  reference: r.reference, status: r.status, booksJournalId: r.books_journal_id, booksEntryNumber: r.books_entry_number,
  attempts: r.attempts, postedBy: r.posted_by, postedAt: r.posted_at, error: r.error,
  voidedBy: r.voided_by, voidedAt: r.voided_at, voidReason: r.void_reason, createdAt: r.created_at, updatedAt: r.updated_at,
} : null);

const SETTINGS_DEFAULTS = { deferred: E.DEFAULT_DEFERRED_SETTINGS, amortization: E.DEFAULT_AMORT_SETTINGS };

function register(app, kit) {
  const { pool, authenticateToken, logActivity } = kit;
  let ready = null;
  const schema = () => (ready = ready || ensureSchema(pool).catch((e) => { ready = null; throw e; }));
  if (pool) schema().catch((e) => console.error('finance managers schema:', e.message));

  // ------------------------------------------------------------------ gardes
  async function readGuard(req, res, mod) {
    if (!(await kit.guardAll(req, res, [P.VIEW, MODULES[mod].perm]))) return false;
    await schema();
    return true;
  }
  async function editGuard(req, res, mod) {
    if (!(await kit.guardAll(req, res, [P.VIEW, MODULES[mod].perm, P.EDIT]))) return false;
    await schema();
    return true;
  }
  async function postGuard(req, res, mod) {
    if (!(await kit.guardAll(req, res, [P.VIEW, MODULES[mod].perm, P.POST]))) return false;
    await schema();
    return true;
  }
  // Correspondance des comptes : partagée par les deux modules (un seul plan comptable).
  async function accountsGuard(req, res, write) {
    if (!(await kit.guardAll(req, res, write ? [P.VIEW, P.POST, P.EDIT] : [P.VIEW, P.POST]))) return false;
    if (!(await kit.can(req, P.DEF)) && !(await kit.can(req, P.AMORT))) { res.status(403).json({ error: 'perm' }); return false; }
    await schema();
    return true;
  }
  const fail = (res, where, e) => { console.error(`finance managers ${where}:`, e.message); res.status(500).json({ error: 'server_error' }); };
  const monthOf = (q) => (E.isMonth(q) ? q : E.currentMonth());

  // ------------------------------------------------------------------ réglages
  async function getSettings(key) {
    const r = await pool.query('SELECT data, version, updated_by, updated_at FROM finance_manager_settings WHERE key = $1', [key]);
    const def = SETTINGS_DEFAULTS[key] || {};
    const row = r.rows[0];
    return { data: { ...def, ...((row && row.data) || {}) }, version: row ? row.version : 0, updatedBy: row ? row.updated_by : null, updatedAt: row ? row.updated_at : null };
  }
  // Concurrence optimiste, comme PUT /api/finance/budgets/:id/state/:section.
  async function saveSettings(key, data, version, email) {
    const out = version === 0
      ? await pool.query(`INSERT INTO finance_manager_settings (key, data, version, updated_by) VALUES ($1, $2::jsonb, 1, $3)
                          ON CONFLICT (key) DO NOTHING RETURNING version`, [key, JSON.stringify(data), email])
      : await pool.query(`UPDATE finance_manager_settings SET data = $2::jsonb, version = version + 1, updated_by = $3, updated_at = NOW()
                          WHERE key = $1 AND version = $4 RETURNING version`, [key, JSON.stringify(data), email, version]);
    return out.rows[0] ? out.rows[0].version : null;
  }
  const accountMap = async () => (await getSettings('books_map')).data.map || {};

  // ------------------------------------------------------------------ écritures déjà passées
  async function livePost(mod, period, kind) {
    const r = await pool.query(
      `SELECT * FROM finance_journal_posts WHERE module = $1 AND period = $2 AND kind = $3 AND status <> 'voided' LIMIT 1`, [mod, period, kind]);
    return r.rows[0] || null;
  }
  async function postHistory(mod, period, kind) {
    const r = await pool.query(
      `SELECT * FROM finance_journal_posts WHERE module = $1 AND period = $2 AND kind = $3 ORDER BY id DESC LIMIT 20`, [mod, period, kind]);
    return r.rows.map(postOut);
  }
  // Une écriture POSTÉE (pas annulée) pour une période ≥ `from` : on ne supprime plus une ligne
  // qui y a contribué (le grand livre ne se réécrit pas en silence).
  async function postedSince(mod, kinds, from) {
    const r = await pool.query(
      `SELECT period FROM finance_journal_posts WHERE module = $1 AND kind = ANY($2) AND status = 'posted' AND period >= $3 ORDER BY period LIMIT 1`,
      [mod, kinds, from]);
    return r.rows[0] ? r.rows[0].period : null;
  }

  // Écriture prête à l'écran : lignes + correspondance Books + état de l'envoi pour la période.
  async function journalView(mod, j, map) {
    const live = await livePost(mod, j.period, j.kind);
    return {
      ...j,
      lines: j.lines.map((l) => ({ ...l, books: l.code && map[l.code] ? { accountId: map[l.code].accountId, accountName: map[l.code].accountName } : null })),
      unmapped: [...new Set(j.lines.filter((l) => l.code && !map[l.code]).map((l) => l.code))],
      post: postOut(live),
      changedSincePost: !!(live && live.status === 'posted' && live.lines_hash !== j.hash),
      history: await postHistory(mod, j.period, j.kind),
    };
  }

  // ------------------------------------------------------------------ références uniques
  // CT-AAAA-NNNN (année du début) / L-AAAA-MM-NN (mois de mise en service). Générées ICI,
  // jamais par le navigateur (le prototype en produisait des doublons).
  async function nextRefs(table, prefixes) {
    const out = new Map();
    for (const prefix of [...new Set(prefixes)]) {
      const r = await pool.query(`SELECT ref FROM ${table} WHERE ref LIKE $1`, [`${prefix}-%`]);
      let max = 0;
      for (const { ref } of r.rows) {
        const m = new RegExp(`^${prefix.replace(/[-]/g, '\\-')}-(\\d+)$`).exec(ref);
        if (m) max = Math.max(max, Number(m[1]));
      }
      out.set(prefix, max);
    }
    return out;
  }
  const contractPrefix = (b) => `CT-${String(b.start_month || b.startMonth).slice(0, 4)}`;
  const lotPrefix = (b) => `L-${b.in_service_month || b.inServiceMonth}`;

  /**
   * Insère des lignes EN UNE instruction (tout ou rien) avec des références uniques. Une
   * référence fournie (import) est gardée si elle est libre ; sinon générée. Une collision
   * concurrente (index unique) relance une fois avec des numéros relus.
   */
  async function insertRows(table, rows, prefixOf, pad, email, source) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const given = rows.map((r) => r.ref).filter(Boolean);
      if (given.length) {
        const taken = await pool.query(`SELECT ref FROM ${table} WHERE ref = ANY($1)`, [given]);
        if (taken.rows.length) { const e = new Error('ref_taken'); e.code = 'ref_taken'; e.refs = taken.rows.map((x) => x.ref); throw e; }
        if (new Set(given).size !== given.length) { const e = new Error('ref_taken'); e.code = 'ref_taken'; e.refs = given; throw e; }
      }
      const seqs = await nextRefs(table, rows.filter((r) => !r.ref).map((r) => prefixOf(r.fields)));
      const all = rows.map((r) => {
        if (r.ref) return { ...r.fields, ref: r.ref };
        const prefix = prefixOf(r.fields);
        const n = seqs.get(prefix) + 1;
        seqs.set(prefix, n);
        return { ...r.fields, ref: `${prefix}-${String(n).padStart(pad, '0')}` };
      });
      const cols = [...new Set(all.flatMap((f) => Object.keys(f)))];
      const params = [];
      const values = all.map((f) => {
        const ph = [...cols, 'created_by', 'updated_by', 'source'].map((c) => {
          params.push(c === 'created_by' || c === 'updated_by' ? email : c === 'source' ? source : (f[c] === undefined ? null : f[c]));
          return `$${params.length}`;
        });
        return `(${ph.join(', ')})`;
      });
      try {
        const r = await pool.query(
          `INSERT INTO ${table} (${[...cols, 'created_by', 'updated_by', 'source'].join(', ')}) VALUES ${values.join(', ')} RETURNING *`, params);
        return r.rows;
      } catch (e) {
        if (String(e.code) === '23505' && attempt < 2 && !given.length) continue;
        throw e;
      }
    }
    throw new Error('ref_generation_failed');
  }

  // Modification avec la version lue ; 409 + ligne courante si quelqu'un a écrit entre-temps.
  async function updateVersioned(table, id, version, fields, email) {
    const cols = Object.keys(fields);
    const r = await pool.query(
      `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}${cols.length ? ', ' : ''}version = version + 1, updated_by = $${cols.length + 3}, updated_at = NOW()
       WHERE id = $1 AND version = $2 RETURNING *`,
      [id, version, ...cols.map((c) => fields[c]), email]);
    if (r.rows[0]) return { row: r.rows[0] };
    const cur = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    return cur.rows[0] ? { conflict: cur.rows[0] } : { missing: true };
  }

  // ------------------------------------------------------------------ fichiers
  const receive = (req, res) => new Promise((resolve) => {
    if (!kit.upload) return resolve('upload_unavailable');
    kit.upload(req, res, (err) => resolve(err ? (err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'upload_failed') : null));
  });
  const sendXlsx = (res, name, buf) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buf);
  };

  // ================================================================== REVENUS REPORTÉS
  async function loadContracts() {
    const r = await pool.query('SELECT * FROM finance_deferred_contracts ORDER BY start_month DESC, id DESC');
    return r.rows.map(contractOut);
  }

  app.get('/api/finance/deferred', authenticateToken, async (req, res) => {
    try {
      if (!(await readGuard(req, res, 'deferred'))) return;
      const month = monthOf(req.query.month);
      const M = E.ym(month);
      const [settings, contracts, map] = await Promise.all([getSettings('deferred'), loadContracts(), accountMap()]);
      const summary = E.deferredSummary(contracts, month, settings.data);
      const { journal, ...tiles } = summary;
      const starts = contracts.map((c) => E.ym(c.startMonth));
      res.json({
        currentMonth: E.currentMonth(),
        month,
        range: {
          first: E.mStr(Math.min(M, E.ym(E.currentMonth()) - 24, ...starts)),
          last: E.mStr(Math.max(M, E.ym(E.currentMonth()) + 24)),
        },
        settings,
        contracts: contracts.map((c) => ({ ...c, calc: E.contractAt(c, M) })),
        summary: tiles,
        journal: await journalView('deferred', journal, map),
        caps: { canEdit: await kit.can(req, P.EDIT), canPost: await kit.can(req, P.POST) },
      });
    } catch (e) { fail(res, 'deferred load', e); }
  });

  app.post('/api/finance/deferred/contracts', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'deferred'))) return;
      const settings = (await getSettings('deferred')).data;
      const v = X.validateContract(req.body, settings, false);
      if (v.error) return res.status(400).json({ error: v.error });
      const ref = req.body && req.body.ref ? String(req.body.ref).trim() : null;
      if (ref && !/^[A-Za-z0-9\-_.]{1,40}$/.test(ref)) return res.status(400).json({ error: 'bad_ref' });
      let rows;
      try { rows = await insertRows('finance_deferred_contracts', [{ fields: v.fields, ref }], contractPrefix, 4, req.user.email, 'manual'); } catch (e) {
        if (e.code === 'ref_taken') return res.status(409).json({ error: 'ref_taken', refs: e.refs });
        throw e;
      }
      const c = contractOut(rows[0]);
      await logActivity('finance_deferred', c.ref, 'contract_added', `Contrat reporté ajouté : ${c.ref} — ${c.customer}`, req.user.email, { metadata: { id: c.id } });
      res.json({ contract: c });
    } catch (e) { fail(res, 'contract add', e); }
  });

  app.patch('/api/finance/deferred/contracts/:id', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'deferred'))) return;
      const settings = (await getSettings('deferred')).data;
      const body = { ...(req.body || {}) };
      const version = Number(body.version);
      delete body.version;
      const v = X.validateContract(body, settings, true);
      if (v.error) return res.status(400).json({ error: v.error });
      if (!Object.keys(v.fields).length) return res.status(400).json({ error: 'nothing_to_update' });
      const u = await updateVersioned('finance_deferred_contracts', Number(req.params.id), version, v.fields, req.user.email);
      if (u.missing) return res.status(404).json({ error: 'not_found' });
      if (u.conflict) return res.status(409).json({ error: 'conflict', current: contractOut(u.conflict) });
      const c = contractOut(u.row);
      await logActivity('finance_deferred', c.ref, 'contract_edited', `Contrat reporté modifié : ${c.ref} (${Object.keys(v.fields).join(', ')})`, req.user.email, { metadata: { id: c.id, fields: Object.keys(v.fields) } });
      res.json({ contract: c });
    } catch (e) { fail(res, 'contract edit', e); }
  });

  // Fermeture anticipée : « release » constate le solde restant au mois choisi ; « cancel »
  // arrête la constatation, le solde restant sort du reporté sans revenu (note de crédit /
  // remboursement passés dans Books par ailleurs).
  app.post('/api/finance/deferred/contracts/:id/close', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'deferred'))) return;
      const b = req.body || {};
      if (!E.isMonth(b.month)) return res.status(400).json({ error: 'bad_month' });
      if (!['release', 'cancel'].includes(b.treatment)) return res.status(400).json({ error: 'bad_treatment' });
      if (b.reason != null && (typeof b.reason !== 'string' || b.reason.length > 500)) return res.status(400).json({ error: 'bad_reason' });
      const u = await updateVersioned('finance_deferred_contracts', Number(req.params.id), Number(b.version),
        { closed_month: b.month, close_treatment: b.treatment, close_reason: b.reason ? b.reason.trim() : null }, req.user.email);
      if (u.missing) return res.status(404).json({ error: 'not_found' });
      if (u.conflict) return res.status(409).json({ error: 'conflict', current: contractOut(u.conflict) });
      const c = contractOut(u.row);
      await logActivity('finance_deferred', c.ref, 'contract_closed', `Contrat reporté fermé : ${c.ref} au ${b.month} (${b.treatment})`, req.user.email, { metadata: { id: c.id, month: b.month, treatment: b.treatment } });
      res.json({ contract: c });
    } catch (e) { fail(res, 'contract close', e); }
  });

  app.post('/api/finance/deferred/contracts/:id/reopen', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'deferred'))) return;
      const u = await updateVersioned('finance_deferred_contracts', Number(req.params.id), Number((req.body || {}).version),
        { closed_month: null, close_treatment: null, close_reason: null }, req.user.email);
      if (u.missing) return res.status(404).json({ error: 'not_found' });
      if (u.conflict) return res.status(409).json({ error: 'conflict', current: contractOut(u.conflict) });
      const c = contractOut(u.row);
      await logActivity('finance_deferred', c.ref, 'contract_reopened', `Contrat reporté rouvert : ${c.ref}`, req.user.email, { metadata: { id: c.id } });
      res.json({ contract: c });
    } catch (e) { fail(res, 'contract reopen', e); }
  });

  app.delete('/api/finance/deferred/contracts/:id', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'deferred'))) return;
      const cur = await pool.query('SELECT * FROM finance_deferred_contracts WHERE id = $1', [Number(req.params.id)]);
      const row = cur.rows[0];
      if (!row) return res.status(404).json({ error: 'not_found' });
      if (Number(req.query.version) !== row.version) return res.status(409).json({ error: 'conflict', current: contractOut(row) });
      const posted = await postedSince('deferred', ['recognition'], row.start_month);
      if (posted) return res.status(409).json({ error: 'posted_periods', period: posted });
      await pool.query('DELETE FROM finance_deferred_contracts WHERE id = $1 AND version = $2', [row.id, row.version]);
      await logActivity('finance_deferred', row.ref, 'contract_removed', `Contrat reporté supprimé : ${row.ref} — ${row.customer}`, req.user.email, { metadata: { id: row.id } });
      res.json({ ok: true });
    } catch (e) { fail(res, 'contract delete', e); }
  });

  app.put('/api/finance/deferred/settings', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'deferred'))) return;
      const used = (await pool.query('SELECT DISTINCT type FROM finance_deferred_contracts')).rows.map((r) => r.type);
      const v = X.validateDeferredSettings(req.body && req.body.data, used);
      if (v.error) return res.status(400).json({ error: v.error, type: v.type });
      const version = await saveSettings('deferred', v.data, Number(req.body.version) || 0, req.user.email);
      if (version == null) return res.status(409).json({ error: 'conflict', current: await getSettings('deferred') });
      await logActivity('finance_deferred', 'settings', 'settings_edited', 'Revenus reportés : comptes et types modifiés', req.user.email, { metadata: v.data });
      res.json({ settings: await getSettings('deferred') });
    } catch (e) { fail(res, 'deferred settings', e); }
  });

  app.get('/api/finance/deferred/template', authenticateToken, async (req, res) => {
    try {
      if (!(await readGuard(req, res, 'deferred'))) return;
      sendXlsx(res, 'deferred-revenue-template.xlsx', X.deferredTemplate((await getSettings('deferred')).data));
    } catch (e) { fail(res, 'deferred template', e); }
  });

  app.get('/api/finance/deferred/export', authenticateToken, async (req, res) => {
    try {
      if (!(await readGuard(req, res, 'deferred'))) return;
      const month = monthOf(req.query.month);
      const rows = (await loadContracts()).map((c) => ({ ...c, calc: E.contractAt(c, E.ym(month)) }));
      sendXlsx(res, `deferred-revenue-${month}.xlsx`, X.contractsExport(rows, month));
    } catch (e) { fail(res, 'deferred export', e); }
  });

  // Doublon probable : même client, type, début, durée et montant qu'un contrat existant (ou
  // qu'une ligne précédente du fichier). Signalé, pas bloqué : la CFO décide.
  const contractKey = (b) => [String(b.customer || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(), b.type, b.startMonth, b.termMonths, Math.round(Number(b.total) * 100)].join('|');

  app.post('/api/finance/deferred/import/preview', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'deferred'))) return;
      const upErr = await receive(req, res);
      if (upErr) return res.status(400).json({ error: upErr });
      if (!req.file) return res.status(400).json({ error: 'no_file' });
      const settings = (await getSettings('deferred')).data;
      const sheet = X.readSheet(kit.readWorkbook(req.file.buffer), X.DEFERRED_COLS, ['customer', 'type', 'startMonth', 'termMonths', 'total']);
      if (sheet.error) return res.status(400).json({ error: sheet.error });
      const existing = new Set((await loadContracts()).map(contractKey));
      const refs = new Set((await pool.query('SELECT ref FROM finance_deferred_contracts')).rows.map((r) => r.ref));
      const seen = new Set();
      const rows = sheet.rows.map(({ line, values }) => {
        const { body, errors } = X.contractFromCells(values, settings);
        const warnings = [];
        const k = contractKey(body);
        if (existing.has(k) || seen.has(k)) warnings.push('duplicate');
        seen.add(k);
        if (body.ref && refs.has(body.ref)) errors.push('ref_taken');
        return { line, body, errors, warnings };
      });
      res.json({ sheet: sheet.sheet, rows, valid: rows.filter((r) => !r.errors.length).length, invalid: rows.filter((r) => r.errors.length).length });
    } catch (e) { fail(res, 'deferred import preview', e); }
  });

  app.post('/api/finance/deferred/import/confirm', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'deferred'))) return;
      const input = req.body && req.body.rows;
      if (!Array.isArray(input) || !input.length || input.length > 2000) return res.status(400).json({ error: 'no_rows' });
      const settings = (await getSettings('deferred')).data;
      // Tout est revalidé ici : l'aperçu n'est qu'un aperçu.
      const errors = [];
      const rows = input.map((b, i) => {
        const v = X.validateContract(b, settings, false);
        const ref = b && b.ref ? String(b.ref).trim() : null;
        if (v.error) errors.push({ index: i, error: v.error });
        else if (ref && !/^[A-Za-z0-9\-_.]{1,40}$/.test(ref)) errors.push({ index: i, error: 'bad_ref' });
        return { fields: v.fields, ref };
      });
      if (errors.length) return res.status(400).json({ error: 'invalid_rows', rows: errors });
      let out;
      try { out = await insertRows('finance_deferred_contracts', rows, contractPrefix, 4, req.user.email, 'import'); } catch (e) {
        if (e.code === 'ref_taken') return res.status(409).json({ error: 'ref_taken', refs: e.refs });
        throw e;
      }
      await logActivity('finance_deferred', 'import', 'contracts_imported', `Revenus reportés : ${out.length} contrat(s) importé(s) d'Excel`, req.user.email, { metadata: { count: out.length, refs: out.map((r) => r.ref) } });
      res.json({ imported: out.length, contracts: out.map(contractOut) });
    } catch (e) { fail(res, 'deferred import confirm', e); }
  });

  // ================================================================== AMORTISSEMENT
  async function loadLots() {
    const r = await pool.query('SELECT * FROM finance_amort_lots ORDER BY in_service_month DESC, id DESC');
    return r.rows.map(lotOut);
  }

  app.get('/api/finance/amortization', authenticateToken, async (req, res) => {
    try {
      if (!(await readGuard(req, res, 'amortization'))) return;
      const month = monthOf(req.query.month);
      const M = E.ym(month);
      const [settings, lots, map] = await Promise.all([getSettings('amortization'), loadLots(), accountMap()]);
      const { journal, writeOffJournal, ...tiles } = E.amortSummary(lots, month, settings.data);
      const starts = lots.map((l) => E.ym(l.inServiceMonth));
      res.json({
        currentMonth: E.currentMonth(),
        month,
        range: {
          first: E.mStr(Math.min(M, E.ym(E.currentMonth()) - 24, ...starts)),
          last: E.mStr(Math.max(M, E.ym(E.currentMonth()) + 24)),
        },
        settings,
        lots: lots.map((l) => ({ ...l, calc: E.lotAt(l, M) })),
        summary: tiles,
        journal: await journalView('amortization', journal, map),
        writeOffJournal: await journalView('amortization', writeOffJournal, map),
        caps: { canEdit: await kit.can(req, P.EDIT), canPost: await kit.can(req, P.POST) },
      });
    } catch (e) { fail(res, 'amortization load', e); }
  });

  const salvageOk = (f) => f.salvage == null || f.salvage <= Number(f.quantity) * Number(f.unit_cost);

  app.post('/api/finance/amortization/lots', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'amortization'))) return;
      const settings = (await getSettings('amortization')).data;
      const v = X.validateLot(req.body, settings, false);
      if (v.error) return res.status(400).json({ error: v.error });
      const ref = req.body && req.body.ref ? String(req.body.ref).trim() : null;
      if (ref && !/^[A-Za-z0-9\-_.]{1,40}$/.test(ref)) return res.status(400).json({ error: 'bad_ref' });
      let rows;
      try { rows = await insertRows('finance_amort_lots', [{ fields: v.fields, ref }], lotPrefix, 2, req.user.email, 'manual'); } catch (e) {
        if (e.code === 'ref_taken') return res.status(409).json({ error: 'ref_taken', refs: e.refs });
        throw e;
      }
      const l = lotOut(rows[0]);
      await logActivity('finance_amortization', l.ref, 'lot_added', `Lot de terminaux ajouté : ${l.ref} — ${l.description} × ${l.quantity}`, req.user.email, { metadata: { id: l.id } });
      res.json({ lot: l });
    } catch (e) { fail(res, 'lot add', e); }
  });

  app.patch('/api/finance/amortization/lots/:id', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'amortization'))) return;
      const settings = (await getSettings('amortization')).data;
      const body = { ...(req.body || {}) };
      const version = Number(body.version);
      delete body.version;
      const v = X.validateLot(body, settings, true);
      if (v.error) return res.status(400).json({ error: v.error });
      if (!Object.keys(v.fields).length) return res.status(400).json({ error: 'nothing_to_update' });
      const cur = (await pool.query('SELECT * FROM finance_amort_lots WHERE id = $1', [Number(req.params.id)])).rows[0];
      if (!cur) return res.status(404).json({ error: 'not_found' });
      if (!salvageOk({ quantity: cur.quantity, unit_cost: cur.unit_cost, salvage: cur.salvage, ...v.fields })) return res.status(400).json({ error: 'salvage_above_cost' });
      const u = await updateVersioned('finance_amort_lots', cur.id, version, v.fields, req.user.email);
      if (u.missing) return res.status(404).json({ error: 'not_found' });
      if (u.conflict) return res.status(409).json({ error: 'conflict', current: lotOut(u.conflict) });
      const l = lotOut(u.row);
      await logActivity('finance_amortization', l.ref, 'lot_edited', `Lot de terminaux modifié : ${l.ref} (${Object.keys(v.fields).join(', ')})`, req.user.email, { metadata: { id: l.id, fields: Object.keys(v.fields) } });
      res.json({ lot: l });
    } catch (e) { fail(res, 'lot edit', e); }
  });

  // Radiation du lot ENTIER au mois choisi : plus de charge ce mois-là ni après, la VNC au début
  // du mois passe en perte par une écriture « writeoff » (traitement selon les réglages).
  app.post('/api/finance/amortization/lots/:id/write-off', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'amortization'))) return;
      const b = req.body || {};
      if (!E.isMonth(b.month)) return res.status(400).json({ error: 'bad_month' });
      if (typeof b.reason !== 'string' || b.reason.trim().length < 3 || b.reason.length > 500) return res.status(400).json({ error: 'bad_reason' });
      const cur = (await pool.query('SELECT * FROM finance_amort_lots WHERE id = $1', [Number(req.params.id)])).rows[0];
      if (!cur) return res.status(404).json({ error: 'not_found' });
      if (cur.written_off_month) return res.status(409).json({ error: 'already_written_off', month: cur.written_off_month });
      // Une écriture de radiation déjà passée pour ce mois changerait : il faut l'annuler d'abord.
      const live = await livePost('amortization', b.month, 'writeoff');
      if (live && live.status === 'posted') return res.status(409).json({ error: 'writeoff_posted', period: b.month });
      const u = await updateVersioned('finance_amort_lots', cur.id, Number(b.version), { written_off_month: b.month, write_off_reason: b.reason.trim() }, req.user.email);
      if (u.missing) return res.status(404).json({ error: 'not_found' });
      if (u.conflict) return res.status(409).json({ error: 'conflict', current: lotOut(u.conflict) });
      const l = lotOut(u.row);
      await logActivity('finance_amortization', l.ref, 'lot_written_off', `Lot de terminaux radié : ${l.ref} au ${b.month}`, req.user.email, { metadata: { id: l.id, month: b.month, reason: l.writeOffReason } });
      res.json({ lot: l });
    } catch (e) { fail(res, 'lot write-off', e); }
  });

  app.post('/api/finance/amortization/lots/:id/restore', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'amortization'))) return;
      const cur = (await pool.query('SELECT * FROM finance_amort_lots WHERE id = $1', [Number(req.params.id)])).rows[0];
      if (!cur) return res.status(404).json({ error: 'not_found' });
      if (!cur.written_off_month) return res.status(409).json({ error: 'not_written_off' });
      const live = await livePost('amortization', cur.written_off_month, 'writeoff');
      if (live && live.status === 'posted') return res.status(409).json({ error: 'writeoff_posted', period: cur.written_off_month });
      const u = await updateVersioned('finance_amort_lots', cur.id, Number((req.body || {}).version), { written_off_month: null, write_off_reason: null }, req.user.email);
      if (u.missing) return res.status(404).json({ error: 'not_found' });
      if (u.conflict) return res.status(409).json({ error: 'conflict', current: lotOut(u.conflict) });
      const l = lotOut(u.row);
      await logActivity('finance_amortization', l.ref, 'lot_restored', `Radiation annulée : ${l.ref}`, req.user.email, { metadata: { id: l.id, month: cur.written_off_month } });
      res.json({ lot: l });
    } catch (e) { fail(res, 'lot restore', e); }
  });

  app.delete('/api/finance/amortization/lots/:id', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'amortization'))) return;
      const row = (await pool.query('SELECT * FROM finance_amort_lots WHERE id = $1', [Number(req.params.id)])).rows[0];
      if (!row) return res.status(404).json({ error: 'not_found' });
      if (Number(req.query.version) !== row.version) return res.status(409).json({ error: 'conflict', current: lotOut(row) });
      const posted = await postedSince('amortization', ['amortization', 'writeoff'], row.in_service_month);
      if (posted) return res.status(409).json({ error: 'posted_periods', period: posted });
      await pool.query('DELETE FROM finance_amort_lots WHERE id = $1 AND version = $2', [row.id, row.version]);
      await logActivity('finance_amortization', row.ref, 'lot_removed', `Lot de terminaux supprimé : ${row.ref} — ${row.description}`, req.user.email, { metadata: { id: row.id } });
      res.json({ ok: true });
    } catch (e) { fail(res, 'lot delete', e); }
  });

  app.put('/api/finance/amortization/settings', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'amortization'))) return;
      const v = X.validateAmortSettings(req.body && req.body.data);
      if (v.error) return res.status(400).json({ error: v.error });
      const version = await saveSettings('amortization', v.data, Number(req.body.version) || 0, req.user.email);
      if (version == null) return res.status(409).json({ error: 'conflict', current: await getSettings('amortization') });
      await logActivity('finance_amortization', 'settings', 'settings_edited', 'Amortissement : comptes et traitement des radiations modifiés', req.user.email, { metadata: v.data });
      res.json({ settings: await getSettings('amortization') });
    } catch (e) { fail(res, 'amortization settings', e); }
  });

  app.get('/api/finance/amortization/template', authenticateToken, async (req, res) => {
    try {
      if (!(await readGuard(req, res, 'amortization'))) return;
      sendXlsx(res, 'terminal-lots-template.xlsx', X.lotTemplate());
    } catch (e) { fail(res, 'amortization template', e); }
  });

  app.get('/api/finance/amortization/export', authenticateToken, async (req, res) => {
    try {
      if (!(await readGuard(req, res, 'amortization'))) return;
      const month = monthOf(req.query.month);
      const rows = (await loadLots()).map((l) => ({ ...l, calc: E.lotAt(l, E.ym(month)) }));
      sendXlsx(res, `terminal-lots-${month}.xlsx`, X.lotsExport(rows, month));
    } catch (e) { fail(res, 'amortization export', e); }
  });

  const lotKey = (b) => [String(b.description || '').toLowerCase().trim(), b.quantity, Math.round(Number(b.unitCost) * 100), b.inServiceMonth].join('|');

  app.post('/api/finance/amortization/import/preview', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'amortization'))) return;
      const upErr = await receive(req, res);
      if (upErr) return res.status(400).json({ error: upErr });
      if (!req.file) return res.status(400).json({ error: 'no_file' });
      const settings = (await getSettings('amortization')).data;
      const sheet = X.readSheet(kit.readWorkbook(req.file.buffer), X.LOT_COLS, ['description', 'quantity', 'unitCost', 'inServiceMonth']);
      if (sheet.error) return res.status(400).json({ error: sheet.error });
      const existing = new Set((await loadLots()).map(lotKey));
      const refs = new Set((await pool.query('SELECT ref FROM finance_amort_lots')).rows.map((r) => r.ref));
      const seen = new Set();
      const rows = sheet.rows.map(({ line, values }) => {
        const { body, errors } = X.lotFromCells(values, settings);
        const warnings = [];
        const k = lotKey(body);
        if (existing.has(k) || seen.has(k)) warnings.push('duplicate');
        seen.add(k);
        if (body.ref && refs.has(body.ref)) errors.push('ref_taken');
        return { line, body, errors, warnings };
      });
      res.json({ sheet: sheet.sheet, rows, valid: rows.filter((r) => !r.errors.length).length, invalid: rows.filter((r) => r.errors.length).length });
    } catch (e) { fail(res, 'amortization import preview', e); }
  });

  app.post('/api/finance/amortization/import/confirm', authenticateToken, async (req, res) => {
    try {
      if (!(await editGuard(req, res, 'amortization'))) return;
      const input = req.body && req.body.rows;
      if (!Array.isArray(input) || !input.length || input.length > 2000) return res.status(400).json({ error: 'no_rows' });
      const settings = (await getSettings('amortization')).data;
      const errors = [];
      const rows = input.map((b, i) => {
        const v = X.validateLot(b, settings, false);
        const ref = b && b.ref ? String(b.ref).trim() : null;
        if (v.error) errors.push({ index: i, error: v.error });
        else if (ref && !/^[A-Za-z0-9\-_.]{1,40}$/.test(ref)) errors.push({ index: i, error: 'bad_ref' });
        return { fields: v.fields, ref };
      });
      if (errors.length) return res.status(400).json({ error: 'invalid_rows', rows: errors });
      let out;
      try { out = await insertRows('finance_amort_lots', rows, lotPrefix, 2, req.user.email, 'import'); } catch (e) {
        if (e.code === 'ref_taken') return res.status(409).json({ error: 'ref_taken', refs: e.refs });
        throw e;
      }
      await logActivity('finance_amortization', 'import', 'lots_imported', `Amortissement : ${out.length} lot(s) importé(s) d'Excel`, req.user.email, { metadata: { count: out.length, refs: out.map((r) => r.ref) } });
      res.json({ imported: out.length, lots: out.map(lotOut) });
    } catch (e) { fail(res, 'amortization import confirm', e); }
  });

  // ================================================================== ÉCRITURES → ZOHO BOOKS
  async function computeJournal(mod, kind, month) {
    if (mod === 'deferred') {
      const settings = (await getSettings('deferred')).data;
      return E.deferredSummary(await loadContracts(), month, settings).journal;
    }
    const s = E.amortSummary(await loadLots(), month, (await getSettings('amortization')).data);
    return kind === 'writeoff' ? s.writeOffJournal : s.journal;
  }

  async function postJournal(req, res, mod, kind) {
    const b = req.body || {};
    const month = b.month;
    if (!E.isMonth(month)) return res.status(400).json({ error: 'bad_month' });
    if (!MODULES[mod].kinds.includes(kind)) return res.status(400).json({ error: 'bad_kind' });
    const j = await computeJournal(mod, kind, month);
    if (!j.lines.length) return res.status(400).json({ error: 'nothing_to_post' });
    if (!j.balanced) return res.status(500).json({ error: 'unbalanced' }); // impossible par construction
    if (j.missingAccounts.length) return res.status(409).json({ error: 'accounts_missing', roles: j.missingAccounts });
    if (j.unknownTypes && j.unknownTypes.length) return res.status(409).json({ error: 'unknown_types', types: j.unknownTypes });
    // Ce que la CFO a vu à l'aperçu doit être exactement ce qui part.
    if (b.hash !== j.hash) return res.status(409).json({ error: 'changed', journal: j });
    const map = await accountMap();
    const unmapped = [...new Set(j.lines.filter((l) => !map[l.code]).map((l) => l.code))];
    if (unmapped.length) return res.status(409).json({ error: 'accounts_unmapped', codes: unmapped });

    // Réservation de la période (idempotence) : une seule écriture vivante par module/période/type.
    const email = req.user.email;
    const voided = (await pool.query(`SELECT COUNT(*)::int AS n FROM finance_journal_posts WHERE module = $1 AND period = $2 AND kind = $3 AND status = 'voided'`, [mod, month, kind])).rows[0].n;
    const reference = `${MODULES[mod].refPrefix[kind]}-${month}${voided ? `-R${voided}` : ''}`;
    let row = (await pool.query(
      `INSERT INTO finance_journal_posts (module, period, kind, lines, lines_hash, total, reference, status, posted_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, 'posting', $8)
       ON CONFLICT (module, period, kind) WHERE status <> 'voided' DO NOTHING RETURNING *`,
      [mod, month, kind, JSON.stringify(j.lines), j.hash, j.debit, reference, email])).rows[0];
    if (!row) {
      // Une tentative ÉCHOUÉE se reprend (même ligne) ; une écriture passée ou en cours, jamais.
      row = (await pool.query(
        `UPDATE finance_journal_posts SET status = 'posting', lines = $4::jsonb, lines_hash = $5, total = $6, reference = $7,
           posted_by = $8, error = NULL, attempts = attempts + 1, updated_at = NOW()
         WHERE module = $1 AND period = $2 AND kind = $3 AND status = 'failed' RETURNING *`,
        [mod, month, kind, JSON.stringify(j.lines), j.hash, j.debit, reference, email])).rows[0];
      if (!row) {
        const live = await livePost(mod, month, kind);
        return res.status(409).json({ error: live && live.status === 'posting' ? 'in_progress' : 'already_posted', post: postOut(live) });
      }
    }

    const roleText = (l) => `${ROLE_TEXT[l.role] || l.role} — ${month}`;
    try {
      const out = await booksClient(kit).createJournal({
        date: j.date,
        reference,
        notes: `Sales Hub · ${KIND_TEXT[kind]} · ${month}${j.lots && j.lots.length ? ` · ${j.lots.join(', ')}` : ''}`,
        lines: j.lines.map((l) => ({ accountId: map[l.code].accountId, side: l.side, amount: l.amount, description: roleText(l) })),
      });
      row = (await pool.query(
        `UPDATE finance_journal_posts SET status = 'posted', books_journal_id = $2, books_entry_number = $3, posted_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`, [row.id, out.id, out.number])).rows[0];
      await logActivity(MODULES[mod].entity, month, 'je_posted',
        `Écriture passée dans Zoho Books : ${reference} (${KIND_TEXT[kind]}) — n° ${out.number || out.id}`, email,
        { metadata: { postId: row.id, kind, period: month, booksJournalId: out.id, debit: j.debit, hash: j.hash } });
      return res.json({ post: postOut(row) });
    } catch (e) {
      const code = e instanceof BooksError ? e.code : 'books_post_failed';
      await pool.query(`UPDATE finance_journal_posts SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`, [row.id, `${code}: ${String(e.message).slice(0, 400)}`]);
      await logActivity(MODULES[mod].entity, month, 'je_failed', `Échec de l'écriture Zoho Books ${reference} : ${code}`, email,
        { metadata: { postId: row.id, kind, period: month, code, message: String(e.message).slice(0, 400) } });
      return res.status(502).json({ error: code, message: e.message, post: postOut((await pool.query('SELECT * FROM finance_journal_posts WHERE id = $1', [row.id])).rows[0]) });
    }
  }

  app.post('/api/finance/deferred/je/post', authenticateToken, async (req, res) => {
    try {
      if (!(await postGuard(req, res, 'deferred'))) return;
      await postJournal(req, res, 'deferred', 'recognition');
    } catch (e) { fail(res, 'deferred je post', e); }
  });
  app.post('/api/finance/amortization/je/post', authenticateToken, async (req, res) => {
    try {
      if (!(await postGuard(req, res, 'amortization'))) return;
      await postJournal(req, res, 'amortization', (req.body && req.body.kind) || 'amortization');
    } catch (e) { fail(res, 'amortization je post', e); }
  });

  // Marquer une écriture annulée : après l'avoir annulée / supprimée DANS BOOKS (Sales Hub n'a
  // pas la portée de suppression). Libère la période pour une nouvelle écriture.
  app.post('/api/finance/je/posts/:id/void', authenticateToken, async (req, res) => {
    try {
      if (!(await kit.guard(req, res, P.VIEW))) return;
      await schema();
      const row = (await pool.query('SELECT * FROM finance_journal_posts WHERE id = $1', [Number(req.params.id)])).rows[0];
      if (!row || !MODULES[row.module]) return res.status(404).json({ error: 'not_found' });
      if (!(await kit.guardAll(req, res, [P.VIEW, MODULES[row.module].perm, P.POST]))) return;
      const reason = (req.body && req.body.reason) || '';
      if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) return res.status(400).json({ error: 'bad_reason' });
      if (row.status === 'voided') return res.status(409).json({ error: 'already_voided', post: postOut(row) });
      if (row.status === 'posting' && Date.now() - new Date(row.updated_at).getTime() < STUCK_MS) return res.status(409).json({ error: 'in_progress', post: postOut(row) });
      const r = (await pool.query(
        `UPDATE finance_journal_posts SET status = 'voided', voided_by = $2, voided_at = NOW(), void_reason = $3, updated_at = NOW()
         WHERE id = $1 AND status = $4 RETURNING *`, [row.id, req.user.email, reason.trim(), row.status])).rows[0];
      if (!r) return res.status(409).json({ error: 'conflict' });
      await logActivity(MODULES[row.module].entity, row.period, 'je_voided',
        `Écriture marquée annulée : ${row.reference || row.id}${row.books_entry_number ? ` (Books n° ${row.books_entry_number})` : ''} — ${reason.trim()}`, req.user.email,
        { metadata: { postId: row.id, kind: row.kind, period: row.period, previousStatus: row.status } });
      res.json({ post: postOut(r) });
    } catch (e) { fail(res, 'je void', e); }
  });

  app.get('/api/finance/je/posts', authenticateToken, async (req, res) => {
    try {
      const mod = String(req.query.module || '');
      if (!MODULES[mod]) return res.status(400).json({ error: 'bad_module' });
      if (!(await readGuard(req, res, mod))) return;
      const r = await pool.query('SELECT * FROM finance_journal_posts WHERE module = $1 ORDER BY period DESC, id DESC LIMIT 200', [mod]);
      res.json({ posts: r.rows.map(postOut) });
    } catch (e) { fail(res, 'je history', e); }
  });

  // ------------------------------------------------------------------ correspondance des comptes
  async function neededCodes() {
    const [d, a] = await Promise.all([getSettings('deferred'), getSettings('amortization')]);
    const out = new Map();
    const add = (code, module, role, label) => {
      if (!code) return;
      if (!out.has(code)) out.set(code, { code, uses: [] });
      out.get(code).uses.push({ module, role, label: label || null });
    };
    add(d.data.deferredAccount, 'deferred', 'deferred');
    for (const t of d.data.types) add(t.account, 'deferred', 'revenue', { en: t.labelEn, fr: t.labelFr });
    add(a.data.expenseAccount, 'amortization', 'amortExpense');
    add(a.data.accumAccount, 'amortization', 'accumAmort');
    add(a.data.assetAccount, 'amortization', 'terminalAsset');
    add(a.data.lossAccount, 'amortization', 'writeOffLoss');
    return [...out.values()].sort((x, y) => x.code.localeCompare(y.code));
  }

  async function accountsPayload() {
    const [coa, mapS, needed] = await Promise.all([getSettings('books_coa'), getSettings('books_map'), neededCodes()]);
    const accounts = coa.data.accounts || null;
    const map = mapS.data.map || {};
    // Suggestion : le compte Books qui porte le même code (jamais appliquée sans confirmation).
    const suggestions = {};
    if (accounts) for (const n of needed) { const hit = accounts.find((a) => a.code === n.code && a.active); if (hit) suggestions[n.code] = hit.id; }
    return { accounts, fetchedAt: coa.data.fetchedAt || null, map, version: mapS.version, needed, suggestions };
  }

  app.get('/api/finance/je/accounts', authenticateToken, async (req, res) => {
    try {
      if (!(await accountsGuard(req, res, false))) return;
      res.json({ ...(await accountsPayload()), caps: { canEdit: await kit.can(req, P.EDIT) } });
    } catch (e) { fail(res, 'je accounts', e); }
  });

  app.post('/api/finance/je/accounts/refresh', authenticateToken, async (req, res) => {
    try {
      if (!(await accountsGuard(req, res, false))) return;
      let accounts;
      try { accounts = await booksClient(kit).chartOfAccounts(); } catch (e) {
        const code = e instanceof BooksError ? e.code : 'books_read_failed';
        return res.status(502).json({ error: code, message: e.message });
      }
      const cur = await getSettings('books_coa');
      const data = { accounts, fetchedAt: new Date().toISOString() };
      if ((await saveSettings('books_coa', data, cur.version, req.user.email)) == null) {
        // Rafraîchi au même moment par quelqu'un d'autre : sa copie fait foi.
      }
      res.json({ ...(await accountsPayload()), caps: { canEdit: await kit.can(req, P.EDIT) } });
    } catch (e) { fail(res, 'je accounts refresh', e); }
  });

  app.put('/api/finance/je/accounts/map', authenticateToken, async (req, res) => {
    try {
      if (!(await accountsGuard(req, res, true))) return;
      const b = req.body || {};
      const input = b.map;
      if (!input || typeof input !== 'object' || Array.isArray(input)) return res.status(400).json({ error: 'bad_map' });
      const accounts = (await getSettings('books_coa')).data.accounts;
      if (!accounts) return res.status(409).json({ error: 'coa_not_loaded' });
      const byId = new Map(accounts.map((a) => [a.id, a]));
      const prev = (await getSettings('books_map')).data.map || {};
      const map = {};
      for (const [code, id] of Object.entries(input)) {
        if (!/^[A-Za-z0-9 .\-]{1,20}$/.test(code)) return res.status(400).json({ error: 'bad_code' });
        if (id == null || id === '') continue;
        const a = byId.get(String(id));
        if (!a) return res.status(400).json({ error: 'unknown_account', code });
        const same = prev[code] && prev[code].accountId === a.id;
        map[code] = {
          accountId: a.id, accountName: a.name, accountCode: a.code,
          confirmedBy: same ? prev[code].confirmedBy : req.user.email,
          confirmedAt: same ? prev[code].confirmedAt : new Date().toISOString(),
        };
      }
      const version = await saveSettings('books_map', { map }, Number(b.version) || 0, req.user.email);
      if (version == null) return res.status(409).json({ error: 'conflict', current: await accountsPayload() });
      await logActivity('finance_deferred', 'books_accounts', 'accounts_mapped', `Correspondance des comptes Zoho Books confirmée (${Object.keys(map).length} compte(s))`, req.user.email,
        { metadata: { map: Object.fromEntries(Object.entries(map).map(([c, v]) => [c, v.accountId])) } });
      res.json({ ...(await accountsPayload()), caps: { canEdit: true } });
    } catch (e) { fail(res, 'je accounts map', e); }
  });
}

module.exports = { register, ensureSchema };
