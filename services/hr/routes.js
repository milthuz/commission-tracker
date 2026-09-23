// ============================================================================
// RH — embauche d'un représentant : offre d'emploi + entente de rémunération, envoi pour
// signature électronique, contresignature, dossier signé.
//
// Monté par UNE ligne dans server.js, comme services/icplus et services/revenueModel.
//
// Cycle de vie d'une embauche (colonne `status`) :
//   draft ──envoyer──▶ sent ──ouvert──▶ viewed ──signé par le candidat──▶ employee_signed
//     ──contresigné par Cluster──▶ completed
//   (sent|viewed) ──refus du candidat──▶ declined        (tout sauf completed) ──▶ cancelled
//
// 🔑 L'INSTANTANÉ. À l'envoi, la fiche, les conditions et le plan sont figés dans `snapshot`,
// et les deux PDF non signés sont rendus UNE fois, stockés, et hachés (SHA-256). Le candidat
// télécharge ces octets-là, et la version signée est re-rendue à partir du même instantané.
// Conséquence voulue : une fiche envoyée n'est plus modifiable. Pour corriger, on annule et on
// renvoie — sinon le candidat signerait un texte différent de celui qu'il a lu.
//
// 🔑 LE LIEN DE SIGNATURE. Jeton aléatoire de 32 octets, seul son SHA-256 est en base (comme les
// invitations d'usagers externes), 14 jours, usage unique : il cesse de permettre une signature
// dès qu'elle a eu lieu, et « Renvoyer » en émet un nouveau (l'ancien meurt). Le courriel est le
// facteur d'authentification — le même modèle que les services de signature grand public.
//
// ⚠️ DONNÉES SENSIBLES : salaire, adresse personnelle. Tout est derrière `hr:view`, rien n'est
// journalisé en clair dans activity_log (seulement l'identifiant et le nom), et le mode démo ne
// peut rien exporter (les routes /pdf sont bloquées par DEMO_BLOCKED_GET_RE).
// ============================================================================

const crypto = require('crypto');
const multer = require('multer');
const P = require('./plan');
const R = require('./pdf');
const E = require('./emails');

const PERM_VIEW = 'hr:view';
const PERM_MANAGE = 'hr:manage';
const PERM_SIGN = 'hr:countersign';
const RECIPIENTS_KEY = 'hr_recipients';
const TOKEN_DAYS = 14;
const MAX_ATTACH = 10 * 1024 * 1024;
const MAX_ATTACH_COUNT = 8;
const MAX_SIG_BYTES = 400 * 1024; // une signature dessinée pèse ~10-40 Ko
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const refOf = (n) => `RH-${String(n).padStart(4, '0')}`;

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_hires (
      id                UUID PRIMARY KEY,
      ref_no            SERIAL,
      status            TEXT NOT NULL DEFAULT 'draft',
      full_name         TEXT NOT NULL,
      email             TEXT NOT NULL,
      data              JSONB NOT NULL,
      terms             JSONB NOT NULL,
      plan              JSONB NOT NULL,
      snapshot          JSONB,
      offer_pdf         BYTEA,
      agreement_pdf     BYTEA,
      doc_hashes        JSONB,
      token_hash        TEXT,
      token_expires_at  TIMESTAMPTZ,
      sent_at           TIMESTAMPTZ,
      viewed_at         TIMESTAMPTZ,
      employee_sig      JSONB,
      employee_signed_at TIMESTAMPTZ,
      company_sig       JSONB,
      completed_at      TIMESTAMPTZ,
      signed_pdf        BYTEA,
      declined_at       TIMESTAMPTZ,
      decline_reason    TEXT,
      cancelled_at      TIMESTAMPTZ,
      salesperson_name  TEXT,
      created_by        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS hr_hires_token ON hr_hires (token_hash) WHERE token_hash IS NOT NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_hire_attachments (
      id          SERIAL PRIMARY KEY,
      hire_id     UUID NOT NULL REFERENCES hr_hires(id) ON DELETE CASCADE,
      filename    TEXT NOT NULL,
      size_bytes  INT NOT NULL,
      sha256      TEXT NOT NULL,
      data        BYTEA NOT NULL,
      uploaded_by TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_hire_events (
      id       SERIAL PRIMARY KEY,
      hire_id  UUID NOT NULL REFERENCES hr_hires(id) ON DELETE CASCADE,
      event    TEXT NOT NULL,
      actor    TEXT,
      ip       TEXT,
      detail   JSONB NOT NULL DEFAULT '{}'::jsonb,
      at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS hr_hire_events_hire ON hr_hire_events (hire_id, at)`);
  // Rôle RH livré avec la fonctionnalité. ON CONFLICT DO NOTHING : si un admin a retouché ses
  // permissions ensuite, on ne les écrase jamais.
  await pool.query(`
    INSERT INTO roles (name, description, permissions, is_system)
    VALUES ('RH', 'Ressources humaines — embauches, contrats et signatures / Human resources — hiring, contracts and signatures',
            '["hr:view","hr:manage","hr:countersign"]'::jsonb, false)
    ON CONFLICT (name) DO NOTHING`);
}

// Adresse du signataire. Railway ajoute l'adresse réelle EN FIN de X-Forwarded-For ; ce qui
// précède peut venir du client. On garde la dernière comme adresse, et la chaîne pour la preuve.
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
  return { ip: parts[parts.length - 1] || req.ip || '', chain: xff };
}

function validSignature(img) {
  if (typeof img !== 'string') return false;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(img);
  if (!m) return false;
  const buf = Buffer.from(m[1], 'base64');
  // En-tête PNG + taille plausible (une case vide exportée pèse ~1-2 Ko).
  return buf.length > 1500 && buf.length < MAX_SIG_BYTES && buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function registerHrRoutes(app, deps) {
  const { authenticateToken, requirePerm, hasPerm, pool, logActivity, sendMail, mailShell, rateLimited, engine } = deps;
  const base = () => process.env.FRONTEND_URL || 'https://saleshub.clusterpos.com';

  let ready = null;
  const schema = () => (ready = ready || ensureSchema(pool).catch((e) => { ready = null; throw e; }));
  // Au démarrage aussi, pour que le rôle RH apparaisse dans Admin → Rôles avant la première
  // visite de /hr. Différé : initializeDatabase() crée `roles` pendant ce temps.
  setTimeout(() => { schema().catch((e) => console.warn('[HR] schema init failed:', e.message)); }, 20000);

  const defaults = () => P.engineDefaults(engine ? engine() : null);
  const can = async (req, perm) => { try { return await hasPerm(req, perm); } catch { return false; } };

  const event = (hireId, ev, actor, ip, detail = {}) => pool.query(
    `INSERT INTO hr_hire_events (hire_id, event, actor, ip, detail) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [hireId, ev, actor || null, ip || null, JSON.stringify(detail)],
  ).catch((e) => console.warn('[HR] event log failed:', e.message));

  const audit = (id, ev, desc, actor) => (typeof logActivity === 'function'
    ? logActivity('hr_hire', id, ev, desc, actor) : Promise.resolve());

  async function recipients() {
    try {
      const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [RECIPIENTS_KEY]);
      let v = r.rows[0] ? r.rows[0].value : [];
      if (typeof v === 'string') v = JSON.parse(v);
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }
  // Avis internes : créateur de la fiche + liste d'Admin → Notifications, sans doublon.
  async function internalTo(row) {
    const list = new Set((await recipients()).map((e) => e.toLowerCase()));
    if (row.created_by) list.add(String(row.created_by).toLowerCase());
    return [...list];
  }

  const LIST_COLS = `id, ref_no, status, full_name, email, data, created_by, created_at, updated_at, sent_at, viewed_at,
    employee_signed_at, completed_at, declined_at, cancelled_at, token_expires_at, salesperson_name`;

  const shapeListItem = (r) => ({
    id: r.id,
    ref: refOf(r.ref_no),
    status: r.status,
    name: r.full_name,
    email: r.email,
    position: r.data.position,
    startDate: r.data.startDate,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sentAt: r.sent_at,
    viewedAt: r.viewed_at,
    employeeSignedAt: r.employee_signed_at,
    completedAt: r.completed_at,
    declinedAt: r.declined_at,
    cancelledAt: r.cancelled_at,
    tokenExpiresAt: r.token_expires_at,
    salespersonName: r.salesperson_name,
  });

  async function loadHire(id) {
    if (!UUID_RE.test(String(id))) return null;
    const r = await pool.query(`SELECT ${LIST_COLS}, terms, plan, snapshot, doc_hashes, decline_reason,
        employee_sig - 'image' AS employee_sig_meta, company_sig - 'image' AS company_sig_meta,
        (signed_pdf IS NOT NULL) AS has_signed
      FROM hr_hires WHERE id = $1`, [id]);
    return r.rows[0] || null;
  }

  async function shapeDetail(r) {
    const [att, ev] = await Promise.all([
      pool.query('SELECT id, filename, size_bytes, sha256, uploaded_by, created_at FROM hr_hire_attachments WHERE hire_id = $1 ORDER BY id', [r.id]),
      pool.query('SELECT event, actor, ip, detail, at FROM hr_hire_events WHERE hire_id = $1 ORDER BY at, id', [r.id]),
    ]);
    const d = defaults();
    return {
      ...shapeListItem(r),
      hire: r.data,
      terms: r.terms,
      plan: r.plan,
      planDiffers: P.planDiffers(r.plan, d),
      declineReason: r.decline_reason,
      employeeSig: r.employee_sig_meta,
      companySig: r.company_sig_meta,
      hasSigned: r.has_signed,
      docHashes: r.doc_hashes,
      attachments: att.rows.map((a) => ({ id: a.id, filename: a.filename, size: a.size_bytes, sha256: a.sha256, uploadedBy: a.uploaded_by, createdAt: a.created_at })),
      events: ev.rows,
    };
  }

  const snapOf = (row) => row.snapshot || { hire: row.data, terms: row.terms, plan: row.plan };

  // -------------------------------------------------------------------------
  // Méta + liste
  // -------------------------------------------------------------------------
  app.get('/api/hr/meta', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_VIEW))) return;
    res.json({
      defaults: defaults(),
      terms: P.BASE_TERMS,
      can: { manage: await can(req, PERM_MANAGE), countersign: await can(req, PERM_SIGN) },
    });
  });

  app.get('/api/hr/hires', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_VIEW))) return;
    try {
      await schema();
      const r = await pool.query(`SELECT ${LIST_COLS} FROM hr_hires ORDER BY created_at DESC LIMIT 500`);
      res.json({ hires: r.rows.map(shapeListItem) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/hr/hires/:id', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_VIEW))) return;
    try {
      await schema();
      const row = await loadHire(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      res.json(await shapeDetail(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -------------------------------------------------------------------------
  // Création / modification (brouillon seulement)
  // -------------------------------------------------------------------------
  app.post('/api/hr/hires', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_MANAGE))) return;
    try {
      await schema();
      const n = P.normalizeHire(req.body, defaults());
      if (!n.ok) return res.status(400).json({ error: 'invalid', fields: n.errors });
      const id = crypto.randomUUID();
      const name = `${n.hire.firstName} ${n.hire.lastName}`;
      await pool.query(
        `INSERT INTO hr_hires (id, full_name, email, data, terms, plan, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)`,
        [id, name, n.hire.email, JSON.stringify(n.hire), JSON.stringify(n.terms), JSON.stringify(n.plan), req.user.email],
      );
      await event(id, 'created', req.user.email);
      await audit(id, 'created', `Hiring file created: ${name}`, req.user.email);
      res.json(await shapeDetail(await loadHire(id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/hr/hires/:id', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_MANAGE))) return;
    try {
      await schema();
      const row = await loadHire(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.status !== 'draft') return res.status(409).json({ error: 'locked', message: 'Only a draft can be edited — cancel and create a new file to change a sent offer.' });
      const n = P.normalizeHire(req.body, defaults());
      if (!n.ok) return res.status(400).json({ error: 'invalid', fields: n.errors });
      await pool.query(
        `UPDATE hr_hires SET full_name = $2, email = $3, data = $4::jsonb, terms = $5::jsonb, plan = $6::jsonb, updated_at = NOW()
         WHERE id = $1 AND status = 'draft'`,
        [row.id, `${n.hire.firstName} ${n.hire.lastName}`, n.hire.email, JSON.stringify(n.hire), JSON.stringify(n.terms), JSON.stringify(n.plan)],
      );
      await event(row.id, 'edited', req.user.email);
      res.json(await shapeDetail(await loadHire(row.id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Dupliquer : repartir d'une fiche existante (annulée, refusée ou autre) en brouillon neuf.
  app.post('/api/hr/hires/:id/duplicate', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_MANAGE))) return;
    try {
      await schema();
      const row = await loadHire(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO hr_hires (id, full_name, email, data, terms, plan, created_by)
         SELECT $2, full_name, email, data, terms, plan, $3 FROM hr_hires WHERE id = $1`,
        [row.id, id, req.user.email],
      );
      await event(id, 'created', req.user.email, null, { duplicatedFrom: refOf(row.ref_no) });
      res.json(await shapeDetail(await loadHire(id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/hr/hires/:id', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_MANAGE))) return;
    try {
      await schema();
      const row = await loadHire(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      // Un dossier qui a été envoyé est une trace (même annulé) : on ne supprime que les brouillons.
      if (row.status !== 'draft') return res.status(409).json({ error: 'Only drafts can be deleted' });
      await pool.query('DELETE FROM hr_hires WHERE id = $1', [row.id]);
      await audit(row.id, 'deleted', `Draft hiring file deleted: ${row.full_name}`, req.user.email);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -------------------------------------------------------------------------
  // Pièces jointes (plans de rémunération, politiques…) — PDF seulement, verrouillées à l'envoi.
  // -------------------------------------------------------------------------
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACH, files: 1 },
  });
  app.post('/api/hr/hires/:id/attachments', authenticateToken, (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (10 MB max)' : err.message });
      next();
    });
  }, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_MANAGE))) return;
    try {
      await schema();
      const row = await loadHire(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.status !== 'draft') return res.status(409).json({ error: 'locked' });
      if (!req.file) return res.status(400).json({ error: 'No file' });
      if (!req.file.buffer.slice(0, 5).equals(Buffer.from('%PDF-'))) return res.status(400).json({ error: 'PDF only' });
      if (!(await R.pageCount(req.file.buffer))) return res.status(400).json({ error: 'Unreadable or protected PDF' });
      const n = (await pool.query('SELECT COUNT(*)::int n FROM hr_hire_attachments WHERE hire_id = $1', [row.id])).rows[0].n;
      if (n >= MAX_ATTACH_COUNT) return res.status(400).json({ error: `At most ${MAX_ATTACH_COUNT} attachments` });
      const filename = String(req.file.originalname || 'document.pdf').replace(/[\r\n"\\/]/g, '_').slice(0, 150);
      await pool.query(
        `INSERT INTO hr_hire_attachments (hire_id, filename, size_bytes, sha256, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.id, filename, req.file.size, sha256(req.file.buffer), req.file.buffer, req.user.email],
      );
      await event(row.id, 'attachment_added', req.user.email, null, { filename });
      res.json(await shapeDetail(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/hr/hires/:id/attachments/:aid', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_MANAGE))) return;
    try {
      await schema();
      const row = await loadHire(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.status !== 'draft') return res.status(409).json({ error: 'locked' });
      const del = await pool.query('DELETE FROM hr_hire_attachments WHERE id = $1 AND hire_id = $2 RETURNING filename', [Number(req.params.aid) || 0, row.id]);
      if (del.rows[0]) await event(row.id, 'attachment_removed', req.user.email, null, { filename: del.rows[0].filename });
      res.json(await shapeDetail(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const sendPdf = (res, buf, filename, inline = true) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  };
  const fileBase = (row) => row.full_name.replace(/[^\w\- ]/g, '').replace(/\s+/g, '_');

  // PDF : brouillon = rendu à la volée (aperçu) ; envoyé = les octets figés ; signé = le dossier.
  app.get('/api/hr/hires/:id/pdf/:doc', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_VIEW))) return;
    try {
      await schema();
      const row = await loadHire(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      const doc = req.params.doc;
      const fb = fileBase(row);
      if (doc === 'signed') {
        const r = await pool.query('SELECT signed_pdf FROM hr_hires WHERE id = $1', [row.id]);
        if (!r.rows[0] || !r.rows[0].signed_pdf) return res.status(404).json({ error: 'Not signed yet' });
        return sendPdf(res, r.rows[0].signed_pdf, `Cluster_Signed_${fb}.pdf`, false);
      }
      if (doc.startsWith('att-')) {
        const a = await pool.query('SELECT filename, data FROM hr_hire_attachments WHERE id = $1 AND hire_id = $2', [Number(doc.slice(4)) || 0, row.id]);
        if (!a.rows[0]) return res.status(404).json({ error: 'Not found' });
        return sendPdf(res, a.rows[0].data, a.rows[0].filename);
      }
      if (doc !== 'offer' && doc !== 'agreement') return res.status(404).json({ error: 'Unknown document' });
      if (row.status !== 'draft') {
        const col = doc === 'offer' ? 'offer_pdf' : 'agreement_pdf';
        const r = await pool.query(`SELECT ${col} AS pdf FROM hr_hires WHERE id = $1`, [row.id]);
        if (r.rows[0] && r.rows[0].pdf) return sendPdf(res, r.rows[0].pdf, `Cluster_${doc === 'offer' ? 'Offer' : 'Agreement'}_${fb}.pdf`);
      }
      const snap = snapOf(row);
      const buf = doc === 'offer' ? await R.renderOffer(snap) : await R.renderAgreement(snap);
      sendPdf(res, buf, `Cluster_${doc === 'offer' ? 'Offer' : 'Agreement'}_${fb}.pdf`);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -------------------------------------------------------------------------
  // Envoi pour signature
  // -------------------------------------------------------------------------
  function newToken() {
    const raw = crypto.randomBytes(32).toString('base64url');
    return { raw, hash: sha256(raw), expires: new Date(Date.now() + TOKEN_DAYS * 86400000) };
  }

  async function mailCandidate(row, snap, rawToken) {
    const link = `${base()}/sign?token=${encodeURIComponent(rawToken)}`;
    const lang = snap.hire.agreementLang === 'fr' ? 'fr' : 'en';
    const m = E.signRequestEmail(mailShell, {
      firstName: snap.hire.firstName, position: lang === 'fr' ? snap.hire.positionFr : snap.hire.position,
      link, expiresDays: TOKEN_DAYS, lang,
    });
    const r = await sendMail(snap.hire.email, m.subject, m.html);
    return { link, mail: r };
  }

  app.post('/api/hr/hires/:id/send', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_MANAGE))) return;
    try {
      await schema();
      const row = await loadHire(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.status !== 'draft') return res.status(409).json({ error: 'Already sent' });
      const att = (await pool.query('SELECT id, filename, sha256 FROM hr_hire_attachments WHERE hire_id = $1 ORDER BY id', [row.id])).rows;
      const snap = {
        ref: refOf(row.ref_no),
        hire: row.data, terms: row.terms, plan: row.plan,
        attachments: att.map((a) => ({ id: a.id, filename: a.filename, sha256: a.sha256 })),
      };
      const offer = await R.renderOffer(snap);
      const agreement = row.data.includeAgreement !== false ? await R.renderAgreement(snap) : null;
      const hashes = {
        offer: { sha256: sha256(offer), pages: await R.pageCount(offer) },
        agreement: agreement ? { sha256: sha256(agreement), pages: await R.pageCount(agreement) } : null,
      };
      const tok = newToken();
      const upd = await pool.query(
        `UPDATE hr_hires SET status = 'sent', snapshot = $2::jsonb, offer_pdf = $3, agreement_pdf = $4, doc_hashes = $5::jsonb,
           token_hash = $6, token_expires_at = $7, sent_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'draft' RETURNING id`,
        [row.id, JSON.stringify(snap), offer, agreement, JSON.stringify(hashes), tok.hash, tok.expires],
      );
      if (!upd.rows[0]) return res.status(409).json({ error: 'Already sent' });
      const out = await mailCandidate(row, snap, tok.raw);
      await event(row.id, 'sent', req.user.email, null, { to: row.email, emailed: out.mail.sent, reason: out.mail.reason || null });
      await audit(row.id, 'sent', `Offer sent for signature: ${row.full_name}`, req.user.email);
      // Le lien n'est rendu que si le courriel n'est pas parti : l'employé RH peut alors le
      // transmettre lui-même. Sinon il ne quitte jamais le serveur que par le courriel.
      res.json({ ...(await shapeDetail(await loadHire(row.id))), emailed: out.mail.sent, link: out.mail.sent ? null : out.link });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/hr/hires/:id/resend', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_MANAGE))) return;
    try {
      await schema();
      const row = await loadHire(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (!['sent', 'viewed'].includes(row.status)) return res.status(409).json({ error: 'Nothing to resend' });
      const tok = newToken();
      await pool.query(`UPDATE hr_hires SET token_hash = $2, token_expires_at = $3, updated_at = NOW() WHERE id = $1`, [row.id, tok.hash, tok.expires]);
      const out = await mailCandidate(row, snapOf(row), tok.raw);
      await event(row.id, 'resent', req.user.email, null, { to: row.email, emailed: out.mail.sent });
      res.json({ ...(await shapeDetail(await loadHire(row.id))), emailed: out.mail.sent, link: out.mail.sent ? null : out.link });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/hr/hires/:id/cancel', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_MANAGE))) return;
    try {
      await schema();
      const row = await loadHire(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (['completed', 'cancelled', 'draft'].includes(row.status)) return res.status(409).json({ error: 'Cannot cancel' });
      await pool.query(`UPDATE hr_hires SET status = 'cancelled', cancelled_at = NOW(), token_hash = NULL, updated_at = NOW() WHERE id = $1`, [row.id]);
      await event(row.id, 'cancelled', req.user.email, null, { reason: String(req.body?.reason || '').slice(0, 500) || null });
      await audit(row.id, 'cancelled', `Offer cancelled: ${row.full_name}`, req.user.email);
      res.json(await shapeDetail(await loadHire(row.id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -------------------------------------------------------------------------
  // Contresignature → dossier final
  // -------------------------------------------------------------------------
  async function buildSignedPackage(id) {
    const r = (await pool.query(`SELECT ref_no, full_name, email, snapshot, doc_hashes, employee_sig, company_sig, sent_at, viewed_at
      FROM hr_hires WHERE id = $1`, [id])).rows[0];
    const snap = r.snapshot;
    const opts = { employeeSig: r.employee_sig, companySig: r.company_sig };
    const offer = await R.renderOffer(snap, opts);
    const agreement = r.doc_hashes && r.doc_hashes.agreement ? await R.renderAgreement(snap, opts) : null;
    const att = (await pool.query('SELECT filename, sha256, data FROM hr_hire_attachments WHERE hire_id = $1 ORDER BY id', [id])).rows;
    const documents = [{ title: 'Offer of Employment (unsigned original)', sha256: r.doc_hashes.offer.sha256, pages: r.doc_hashes.offer.pages }];
    if (agreement) documents.push({ title: 'Compensation Agreement (unsigned original)', sha256: r.doc_hashes.agreement.sha256, pages: r.doc_hashes.agreement.pages });
    for (const a of att) documents.push({ title: a.filename, sha256: a.sha256 });
    const cert = await R.renderCertificate({
      ref: refOf(r.ref_no), name: r.full_name, documents,
      sentAt: r.sent_at, viewedAt: r.viewed_at,
      employee: { name: r.full_name, email: r.email, at: r.employee_sig.at, typedName: r.employee_sig.name, ip: r.employee_sig.ip, ua: r.employee_sig.ua },
      company: { name: r.company_sig.name, email: r.company_sig.email, at: r.company_sig.at, ip: r.company_sig.ip },
    });
    return R.mergePdfs([offer, agreement, ...att.map((a) => a.data), cert]);
  }

  app.post('/api/hr/hires/:id/countersign', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SIGN))) return;
    try {
      await schema();
      const row = await loadHire(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.status !== 'employee_signed') return res.status(409).json({ error: 'The employee has not signed yet' });
      const name = String(req.body?.name || '').trim().slice(0, 120);
      if (!name) return res.status(400).json({ error: 'name required' });
      if (!validSignature(req.body?.signature)) return res.status(400).json({ error: 'signature required' });
      const { ip } = clientIp(req);
      const sig = { name, email: req.user.email, image: req.body.signature, at: new Date().toISOString(), ip };
      const upd = await pool.query(
        `UPDATE hr_hires SET company_sig = $2::jsonb, updated_at = NOW() WHERE id = $1 AND status = 'employee_signed' RETURNING id`,
        [row.id, JSON.stringify(sig)],
      );
      if (!upd.rows[0]) return res.status(409).json({ error: 'Already countersigned' });
      const pdf = await buildSignedPackage(row.id);
      await pool.query(`UPDATE hr_hires SET status = 'completed', signed_pdf = $2, completed_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id, pdf]);
      await event(row.id, 'countersigned', req.user.email, ip, { name });
      await audit(row.id, 'completed', `Hiring package fully signed: ${row.full_name}`, req.user.email);

      // Copies signées : au candidat et aux destinataires internes.
      const snap = row.snapshot;
      const lang = snap.hire.agreementLang === 'fr' ? 'fr' : 'en';
      const attachment = [{ filename: `Cluster_Signed_${fileBase(row)}.pdf`, content: pdf, contentType: 'application/pdf' }];
      const me = E.completedEmployeeEmail(mailShell, { firstName: snap.hire.firstName, lang, startDate: R.longDate(snap.hire.startDate, lang) });
      const toEmp = await sendMail(row.email, me.subject, me.html, { attachments: attachment });
      const mi = E.completedInternalEmail(mailShell, {
        name: row.full_name, position: snap.hire.position, startDate: R.longDate(snap.hire.startDate, 'fr'), link: `${base()}/hr?id=${row.id}`,
      });
      const to = await internalTo(row);
      if (to.length) await sendMail(to.join(','), mi.subject, mi.html, { attachments: attachment });
      await event(row.id, 'copies_sent', 'system', null, { employee: toEmp.sent, internal: to.length });
      res.json({ ...(await shapeDetail(await loadHire(row.id))), emailed: toEmp.sent });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -------------------------------------------------------------------------
  // Après signature : créer le représentant dans Sales Hub
  // -------------------------------------------------------------------------
  // Remplit la fiche `salespeople` que le moteur de commissions lit déjà : date d'embauche
  // (période d'intégration de 90 jours), salaire annuel, courriel de connexion, prime
  // d'activation et quota s'ils diffèrent du défaut. Un représentant qui EXISTE déjà n'est
  // jamais écrasé : on ne complète que les champs vides.
  app.post('/api/hr/hires/:id/create-salesperson', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_MANAGE))) return;
    try {
      await schema();
      const row = await loadHire(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.status !== 'completed') return res.status(409).json({ error: 'Contract not fully signed yet' });
      const snap = row.snapshot;
      const name = String(req.body?.name || row.full_name).trim().slice(0, 255);
      const d = defaults();
      const quota = snap.plan.monthlyQuota !== d.monthlyQuota ? snap.plan.monthlyQuota : null;
      const r = await pool.query(
        `INSERT INTO salespeople (name, is_active, email, hire_date, base_salary, signup_bonus_amount, monthly_quota)
         VALUES ($1, true, $2, $3::date, $4, $5, $6)
         ON CONFLICT (name) DO UPDATE SET
           email = COALESCE(NULLIF(salespeople.email, ''), EXCLUDED.email),
           hire_date = COALESCE(salespeople.hire_date, EXCLUDED.hire_date),
           base_salary = CASE WHEN COALESCE(salespeople.base_salary, 0) = 0 THEN EXCLUDED.base_salary ELSE salespeople.base_salary END,
           updated_at = CURRENT_TIMESTAMP
         RETURNING (xmax = 0) AS inserted`,
        [name, snap.hire.email, snap.hire.startDate, snap.hire.annualSalary, snap.plan.signupBonus, quota],
      );
      await pool.query('UPDATE hr_hires SET salesperson_name = $2, updated_at = NOW() WHERE id = $1', [row.id, name]);
      const inserted = !!(r.rows[0] && r.rows[0].inserted);
      await event(row.id, 'salesperson_linked', req.user.email, null, { name, created: inserted });
      await audit(row.id, 'salesperson_linked', `Salesperson ${inserted ? 'created' : 'linked'} from hiring file: ${name}`, req.user.email);
      res.json({ ...(await shapeDetail(await loadHire(row.id))), created: inserted });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -------------------------------------------------------------------------
  // Destinataires des avis RH (Admin → Notifications)
  // -------------------------------------------------------------------------
  const canRecipients = async (req, res) => {
    if (await can(req, 'admin:notifications') || await can(req, PERM_MANAGE)) return true;
    res.status(403).json({ error: 'Permission required: hr:manage' });
    return false;
  };
  app.get('/api/admin/hr-recipients', authenticateToken, async (req, res) => {
    if (!(await canRecipients(req, res))) return;
    res.json({ recipients: await recipients() });
  });
  app.put('/api/admin/hr-recipients', authenticateToken, async (req, res) => {
    if (!(await canRecipients(req, res))) return;
    const emails = Array.isArray(req.body?.emails) ? req.body.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean) : null;
    if (!emails) return res.status(400).json({ error: 'emails array required' });
    if (emails.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) return res.status(400).json({ error: 'invalid email' });
    try {
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [RECIPIENTS_KEY, JSON.stringify([...new Set(emails)])],
      );
      res.json({ recipients: [...new Set(emails)] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // =========================================================================
  // PUBLIC — page de signature du candidat (/sign?token=…). Aucune session : le jeton EST
  // l'autorisation. Limité en débit par adresse.
  // =========================================================================
  async function byToken(req, res) {
    const raw = String(req.params.token || '');
    if (rateLimited(`hrsign:${clientIp(req).ip}`, 60)) { res.status(429).json({ error: 'Too many requests' }); return null; }
    if (raw.length < 20 || raw.length > 100) { res.status(404).json({ error: 'invalid' }); return null; }
    await schema();
    const r = await pool.query(`SELECT id, ref_no, status, full_name, email, snapshot, doc_hashes, token_expires_at, viewed_at,
        employee_signed_at, completed_at FROM hr_hires WHERE token_hash = $1`, [sha256(raw)]);
    const row = r.rows[0];
    if (!row) { res.status(404).json({ error: 'invalid' }); return null; }
    if (row.status === 'cancelled') { res.status(410).json({ error: 'cancelled' }); return null; }
    if (['sent', 'viewed'].includes(row.status) && new Date(row.token_expires_at) < new Date()) { res.status(410).json({ error: 'expired' }); return null; }
    return row;
  }

  const publicDocs = (row) => {
    const s = row.snapshot;
    const fr = s.hire.agreementLang === 'fr';
    const docs = [{ key: 'offer', title: fr ? 'Offre d’emploi (en anglais)' : 'Offer of Employment', pages: row.doc_hashes.offer.pages }];
    if (row.doc_hashes.agreement) docs.push({ key: 'agreement', title: fr ? 'Entente de rémunération' : 'Compensation Agreement', pages: row.doc_hashes.agreement.pages });
    for (const a of s.attachments || []) docs.push({ key: `att-${a.id}`, title: a.filename.replace(/\.pdf$/i, ''), pages: null });
    return docs;
  };

  app.get('/api/public/hr-sign/:token', async (req, res) => {
    try {
      const row = await byToken(req, res);
      if (!row) return;
      if (!row.viewed_at && row.status === 'sent') {
        const { ip } = clientIp(req);
        await pool.query(`UPDATE hr_hires SET status = 'viewed', viewed_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'sent'`, [row.id]);
        await event(row.id, 'viewed', row.email, ip, { ua: String(req.headers['user-agent'] || '').slice(0, 300) });
      }
      const s = row.snapshot;
      res.json({
        ref: refOf(row.ref_no),
        status: row.status === 'sent' ? 'viewed' : row.status,
        firstName: s.hire.firstName,
        name: row.full_name,
        position: s.hire.agreementLang === 'fr' ? s.hire.positionFr : s.hire.position,
        startDate: s.hire.startDate,
        lang: s.hire.agreementLang,
        documents: publicDocs(row),
        signedAt: row.employee_signed_at,
        completedAt: row.completed_at,
      });
    } catch (e) { res.status(500).json({ error: 'server' }); }
  });

  app.get('/api/public/hr-sign/:token/doc/:doc', async (req, res) => {
    try {
      const row = await byToken(req, res);
      if (!row) return;
      const doc = req.params.doc;
      if (doc === 'offer' || doc === 'agreement') {
        const col = doc === 'offer' ? 'offer_pdf' : 'agreement_pdf';
        const r = await pool.query(`SELECT ${col} AS pdf FROM hr_hires WHERE id = $1`, [row.id]);
        if (!r.rows[0] || !r.rows[0].pdf) return res.status(404).json({ error: 'Not found' });
        return sendPdf(res, r.rows[0].pdf, `Cluster_${doc === 'offer' ? 'Offer' : 'Agreement'}.pdf`);
      }
      if (doc.startsWith('att-')) {
        const ids = (row.snapshot.attachments || []).map((a) => a.id);
        const aid = Number(doc.slice(4)) || 0;
        if (!ids.includes(aid)) return res.status(404).json({ error: 'Not found' });
        const a = await pool.query('SELECT filename, data FROM hr_hire_attachments WHERE id = $1 AND hire_id = $2', [aid, row.id]);
        if (!a.rows[0]) return res.status(404).json({ error: 'Not found' });
        return sendPdf(res, a.rows[0].data, a.rows[0].filename);
      }
      res.status(404).json({ error: 'Not found' });
    } catch (e) { res.status(500).json({ error: 'server' }); }
  });

  app.post('/api/public/hr-sign/:token/sign', async (req, res) => {
    try {
      const row = await byToken(req, res);
      if (!row) return;
      if (!['sent', 'viewed'].includes(row.status)) return res.status(409).json({ error: 'already_signed' });
      const typed = String(req.body?.fullName || '').trim().slice(0, 120);
      if (!typed) return res.status(400).json({ error: 'name_required' });
      if (req.body?.consent !== true) return res.status(400).json({ error: 'consent_required' });
      if (!validSignature(req.body?.signature)) return res.status(400).json({ error: 'signature_required' });
      const { ip, chain } = clientIp(req);
      const ua = String(req.headers['user-agent'] || '').slice(0, 300);
      const sig = { name: typed, image: req.body.signature, at: new Date().toISOString(), ip, ipChain: chain, ua, consent: true };
      const upd = await pool.query(
        `UPDATE hr_hires SET status = 'employee_signed', employee_sig = $2::jsonb, employee_signed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status IN ('sent','viewed') RETURNING created_by`,
        [row.id, JSON.stringify(sig)],
      );
      if (!upd.rows[0]) return res.status(409).json({ error: 'already_signed' });
      await event(row.id, 'employee_signed', row.email, ip, { typedName: typed, ua });
      await audit(row.id, 'employee_signed', `Employee signed: ${row.full_name}`, row.email);
      const to = await internalTo({ created_by: upd.rows[0].created_by });
      if (to.length) {
        const m = E.countersignEmail(mailShell, { name: row.full_name, position: row.snapshot.hire.position, link: `${base()}/hr?id=${row.id}` });
        await sendMail(to.join(','), m.subject, m.html);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'server' }); }
  });

  app.post('/api/public/hr-sign/:token/decline', async (req, res) => {
    try {
      const row = await byToken(req, res);
      if (!row) return;
      if (!['sent', 'viewed'].includes(row.status)) return res.status(409).json({ error: 'not_pending' });
      const reason = String(req.body?.reason || '').trim().slice(0, 1000);
      const { ip } = clientIp(req);
      const upd = await pool.query(
        `UPDATE hr_hires SET status = 'declined', declined_at = NOW(), decline_reason = $2, token_hash = NULL, updated_at = NOW()
         WHERE id = $1 AND status IN ('sent','viewed') RETURNING created_by`,
        [row.id, reason || null],
      );
      if (!upd.rows[0]) return res.status(409).json({ error: 'not_pending' });
      await event(row.id, 'declined', row.email, ip, { reason: reason || null });
      await audit(row.id, 'declined', `Offer declined: ${row.full_name}`, row.email);
      const to = await internalTo({ created_by: upd.rows[0].created_by });
      if (to.length) {
        const m = E.declinedEmail(mailShell, { name: row.full_name, reason, link: `${base()}/hr?id=${row.id}` });
        await sendMail(to.join(','), m.subject, m.html);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'server' }); }
  });
}

module.exports = { registerHrRoutes, ensureSchema };
