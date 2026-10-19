// ============================================================================
// NDA — ententes de confidentialité envoyées pour signature électronique.
//
// Monté par UNE ligne dans server.js, comme services/hr. Même circuit de signature que les
// embauches (lien personnel haché, instantané figé, PDF non signés hachés, certificat), mais :
//
//   🔑 N'IMPORTE QUELLE équipe prépare et envoie (produit, ventes…) — `nda:send` ;
//   🔑 Cluster est TOUJOURS signé par la même personne (David, demande du 2026-10-19). Le
//      signataire est un réglage (`app_settings.nda_signer` : nom, titre, courriel), imprimé sur
//      le NDA dès l'envoi et figé dans l'instantané. Contresigner exige `nda:countersign` ET
//      d'être connecté avec CE courriel-là (jamais en usurpation) : la permission seule ne
//      suffit pas, sinon un admin pourrait signer « David Lafleur » à sa place.
//
// Deux modes :
//   - `template` : le NDA mutuel de Cluster (services/nda/text.js), EN ou FR ;
//   - `upload`   : le NDA de l'autre partie (PDF déposé) + une page de signature générée qui le
//                  nomme avec son empreinte SHA-256 (comme les addenda RH).
//
// Cycle de vie (`status`) :
//   draft ──envoyer──▶ sent ──ouvert──▶ viewed ──signé par l'autre partie──▶ party_signed
//     ──contresigné par Cluster──▶ completed
//   (sent|viewed) ──refus──▶ declined            (tout sauf completed) ──annuler──▶ cancelled
// ============================================================================

const crypto = require('crypto');
const multer = require('multer');
const R = require('./pdf');
const E = require('./emails');
const T = require('./text');

const PERM_SEND = 'nda:send';
const PERM_VIEW_ALL = 'nda:view_all';
const PERM_SIGN = 'nda:countersign';
const SIGNER_KEY = 'nda_signer';
const TOKEN_DAYS = 14;
const MAX_ATTACH = 10 * 1024 * 1024;
const MAX_ATTACH_COUNT = 3;
const MAX_SIG_BYTES = 400 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DELETABLE = ['draft', 'cancelled', 'declined'];
const DEFAULT_SIGNER = { name: 'David Lafleur', titleEn: 'Vice-President', titleFr: 'Vice-président', email: 'david@clustersystems.com' };

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const refOf = (n) => `NDA-${String(n).padStart(4, '0')}`;
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nda_agreements (
      id                UUID PRIMARY KEY,
      ref_no            SERIAL,
      status            TEXT NOT NULL DEFAULT 'draft',
      mode              TEXT NOT NULL DEFAULT 'template',
      company           TEXT NOT NULL,
      email             TEXT NOT NULL,
      data              JSONB NOT NULL,
      snapshot          JSONB,
      unsigned_pdf      BYTEA,
      doc_hashes        JSONB,
      token_hash        TEXT,
      token_expires_at  TIMESTAMPTZ,
      sent_at           TIMESTAMPTZ,
      viewed_at         TIMESTAMPTZ,
      party_sig         JSONB,
      party_signed_at   TIMESTAMPTZ,
      cluster_sig       JSONB,
      completed_at      TIMESTAMPTZ,
      signed_pdf        BYTEA,
      declined_at       TIMESTAMPTZ,
      decline_reason    TEXT,
      cancelled_at      TIMESTAMPTZ,
      created_by        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS nda_agreements_token ON nda_agreements (token_hash) WHERE token_hash IS NOT NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nda_attachments (
      id          SERIAL PRIMARY KEY,
      nda_id      UUID NOT NULL REFERENCES nda_agreements(id) ON DELETE CASCADE,
      filename    TEXT NOT NULL,
      size_bytes  INT NOT NULL,
      sha256      TEXT NOT NULL,
      data        BYTEA NOT NULL,
      uploaded_by TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nda_events (
      id       SERIAL PRIMARY KEY,
      nda_id   UUID NOT NULL REFERENCES nda_agreements(id) ON DELETE CASCADE,
      event    TEXT NOT NULL,
      actor    TEXT,
      ip       TEXT,
      detail   JSONB NOT NULL DEFAULT '{}'::jsonb,
      at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS nda_events_nda ON nda_events (nda_id, at)`);
}

// Fiche validée. Renvoie { ok, data, errors } — `errors` = noms de champs, pour l'interface.
function normalize(body) {
  const b = body || {};
  const errors = [];
  const c = b.company || {};
  const s = b.signer || {};
  const data = {
    mode: b.mode === 'upload' ? 'upload' : 'template',
    lang: b.lang === 'fr' ? 'fr' : 'en',
    company: {
      legalName: str(c.legalName, 160), address: str(c.address, 200), city: str(c.city, 100),
      province: str(c.province, 60), postalCode: str(c.postalCode, 20), country: str(c.country, 60) || 'Canada',
    },
    signer: { firstName: str(s.firstName, 80), lastName: str(s.lastName, 80), title: str(s.title, 120), email: str(s.email, 200).toLowerCase() },
    purpose: str(b.purpose, 400),
    effectiveDate: /^\d{4}-\d{2}-\d{2}$/.test(String(b.effectiveDate || '')) ? b.effectiveDate : '',
    team: str(b.team, 80),
    notes: str(b.notes, 2000),
  };
  if (!data.company.legalName) errors.push('company.legalName');
  if (data.mode === 'template' && !data.company.address) errors.push('company.address');
  if (data.mode === 'template' && !data.company.city) errors.push('company.city');
  if (!data.signer.firstName) errors.push('signer.firstName');
  if (!data.signer.lastName) errors.push('signer.lastName');
  if (!data.signer.title) errors.push('signer.title');
  if (!EMAIL_RE.test(data.signer.email)) errors.push('signer.email');
  return { ok: errors.length === 0, data, errors };
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  const parts = xff.split(',').map((x) => x.trim()).filter(Boolean);
  return { ip: parts[parts.length - 1] || req.ip || '', chain: xff };
}

function validSignature(img) {
  if (typeof img !== 'string') return false;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(img);
  if (!m) return false;
  const buf = Buffer.from(m[1], 'base64');
  return buf.length > 1500 && buf.length < MAX_SIG_BYTES && buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function registerNdaRoutes(app, deps) {
  const { authenticateToken, requirePerm, hasPerm, pool, logActivity, sendMail, mailShell, rateLimited } = deps;
  const base = () => process.env.FRONTEND_URL || 'https://saleshub.clusterpos.com';

  let ready = null;
  const schema = () => (ready = ready || ensureSchema(pool).catch((e) => { ready = null; throw e; }));
  setTimeout(() => { schema().catch((e) => console.warn('[NDA] schema init failed:', e.message)); }, 20000);

  const can = async (req, perm) => { try { return await hasPerm(req, perm); } catch { return false; } };
  const canAny = async (req, ...perms) => { for (const p of perms) if (await can(req, p)) return true; return false; };

  const event = (id, ev, actor, ip, detail = {}) => pool.query(
    `INSERT INTO nda_events (nda_id, event, actor, ip, detail) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [id, ev, actor || null, ip || null, JSON.stringify(detail)],
  ).catch((e) => console.warn('[NDA] event log failed:', e.message));
  const audit = (id, ev, desc, actor) => (typeof logActivity === 'function' ? logActivity('nda', id, ev, desc, actor) : Promise.resolve());

  async function readSigner() {
    try {
      const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [SIGNER_KEY]);
      let v = r.rows[0] ? r.rows[0].value : null;
      if (typeof v === 'string') v = JSON.parse(v);
      return v && v.email ? { ...DEFAULT_SIGNER, ...v } : DEFAULT_SIGNER;
    } catch { return DEFAULT_SIGNER; }
  }
  // Seul le signataire configuré contresigne — et jamais pendant une usurpation d'identité.
  const isSigner = (req, signer) => !req.user.impersonating
    && String(req.user.email || '').toLowerCase() === String(signer.email || '').toLowerCase();

  // Portée : `nda:view_all` et le signataire voient tout ; `nda:send` voit ce qu'il a créé.
  async function scope(req) {
    if (await canAny(req, PERM_VIEW_ALL, PERM_SIGN)) return { all: true };
    if (await can(req, PERM_SEND)) return { all: false, email: String(req.user.email || '').toLowerCase() };
    return null;
  }
  const inScope = (sc, row) => sc && (sc.all || String(row.created_by || '').toLowerCase() === sc.email);

  // Fiche lisible : refuse 403 sans aucune permission NDA, 404 hors portée.
  async function loadForReq(req, res) {
    const sc = await scope(req);
    if (!sc) { res.status(403).json({ error: 'Permission required: nda:send' }); return null; }
    await schema();
    const row = await loadNda(req.params.id);
    if (!row || !inScope(sc, row)) { res.status(404).json({ error: 'Not found' }); return null; }
    return row;
  }

  const LIST_COLS = `id, ref_no, status, mode, company, email, data, created_by, created_at, updated_at, sent_at, viewed_at,
    party_signed_at, completed_at, declined_at, cancelled_at, token_expires_at`;
  const shapeListItem = (r) => ({
    id: r.id, ref: refOf(r.ref_no), status: r.status, mode: r.mode, company: r.company, email: r.email,
    signerName: `${r.data.signer.firstName} ${r.data.signer.lastName}`.trim(), team: r.data.team || '',
    lang: r.data.lang, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    sentAt: r.sent_at, viewedAt: r.viewed_at, partySignedAt: r.party_signed_at, completedAt: r.completed_at,
    declinedAt: r.declined_at, cancelledAt: r.cancelled_at, tokenExpiresAt: r.token_expires_at,
  });
  async function loadNda(id) {
    if (!UUID_RE.test(String(id))) return null;
    const r = await pool.query(`SELECT ${LIST_COLS}, snapshot, doc_hashes, decline_reason,
        party_sig - 'image' AS party_sig_meta, cluster_sig - 'image' AS cluster_sig_meta
      FROM nda_agreements WHERE id = $1`, [id]);
    return r.rows[0] || null;
  }
  async function shapeDetail(r) {
    const [att, ev] = await Promise.all([
      pool.query('SELECT id, filename, size_bytes, sha256, uploaded_by, created_at FROM nda_attachments WHERE nda_id = $1 ORDER BY id', [r.id]),
      pool.query('SELECT event, actor, ip, detail, at FROM nda_events WHERE nda_id = $1 ORDER BY at, id', [r.id]),
    ]);
    return {
      ...shapeListItem(r),
      nda: r.data,
      clusterSigner: r.snapshot ? r.snapshot.clusterSigner : null,
      declineReason: r.decline_reason,
      partySig: r.party_sig_meta,
      clusterSig: r.cluster_sig_meta,
      docHashes: r.doc_hashes,
      attachments: att.rows.map((a) => ({ id: a.id, filename: a.filename, size: a.size_bytes, sha256: a.sha256, uploadedBy: a.uploaded_by, createdAt: a.created_at })),
      events: ev.rows,
    };
  }
  async function attachmentsWithPages(id) {
    const rows = (await pool.query('SELECT id, filename, sha256, data FROM nda_attachments WHERE nda_id = $1 ORDER BY id', [id])).rows;
    const out = [];
    for (const a of rows) out.push({ id: a.id, filename: a.filename, sha256: a.sha256, pages: await R.pageCount(a.data) });
    return out;
  }
  const signerFor = (signer, lang) => ({ name: signer.name, title: lang === 'fr' ? (signer.titleFr || signer.titleEn) : (signer.titleEn || signer.titleFr), email: signer.email });
  // Instantané d'un brouillon (aperçu) ou celui figé à l'envoi.
  const snapOf = async (row) => row.snapshot || {
    ref: refOf(row.ref_no), nda: row.data, clusterSigner: signerFor(await readSigner(), row.data.lang),
    attachments: row.mode === 'upload' ? await attachmentsWithPages(row.id) : [],
  };
  const render = (snap, sigs = {}) => (snap.nda.mode === 'upload' ? R.renderUploadSignature(snap, sigs) : R.renderNda(snap, sigs));

  const sendPdf = (res, buf, filename, inline = true) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    // Buffer.from : un BYTEA lu par un autre pilote que `pg` peut arriver en Uint8Array, que
    // res.send() sérialiserait en JSON.
    res.send(Buffer.from(buf));
  };
  const fileBase = (row) => String(row.company).replace(/[^\w\- ]/g, '').trim().replace(/\s+/g, '_') || 'NDA';

  // -------------------------------------------------------------------------
  // Méta, signataire, liste, fiche
  // -------------------------------------------------------------------------
  app.get('/api/nda/meta', authenticateToken, async (req, res) => {
    const sc = await scope(req);
    if (!sc) return res.status(403).json({ error: 'Permission required: nda:send' });
    const signer = await readSigner();
    res.json({
      signer,
      defaultPurpose: T.DEFAULT_PURPOSE,
      can: { send: await can(req, PERM_SEND), viewAll: sc.all, countersign: (await can(req, PERM_SIGN)) && isSigner(req, signer), editSigner: await can(req, PERM_SIGN) },
    });
  });

  app.put('/api/nda/signer', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SIGN))) return;
    const b = req.body || {};
    const v = { name: str(b.name, 120), titleEn: str(b.titleEn, 120), titleFr: str(b.titleFr, 120), email: str(b.email, 200).toLowerCase() };
    if (!v.name || !EMAIL_RE.test(v.email)) return res.status(400).json({ error: 'name and email required' });
    try {
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [SIGNER_KEY, JSON.stringify(v)],
      );
      await audit('signer', 'updated', `NDA signatory for Cluster set to ${v.name} <${v.email}>`, req.user.email);
      res.json({ signer: v });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/nda/agreements', authenticateToken, async (req, res) => {
    const sc = await scope(req);
    if (!sc) return res.status(403).json({ error: 'Permission required: nda:send' });
    try {
      await schema();
      const r = sc.all
        ? await pool.query(`SELECT ${LIST_COLS} FROM nda_agreements ORDER BY created_at DESC LIMIT 500`)
        : await pool.query(`SELECT ${LIST_COLS} FROM nda_agreements WHERE LOWER(created_by) = $1 ORDER BY created_at DESC LIMIT 500`, [sc.email]);
      res.json({ agreements: r.rows.map(shapeListItem) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/nda/agreements/:id', authenticateToken, async (req, res) => {
    try {
      const row = await loadForReq(req, res);
      if (row) res.json(await shapeDetail(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -------------------------------------------------------------------------
  // Création / modification (brouillon seulement)
  // -------------------------------------------------------------------------
  app.post('/api/nda/agreements', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SEND))) return;
    try {
      await schema();
      const n = normalize(req.body);
      if (!n.ok) return res.status(400).json({ error: 'invalid', fields: n.errors });
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO nda_agreements (id, mode, company, email, data, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [id, n.data.mode, n.data.company.legalName, n.data.signer.email, JSON.stringify(n.data), req.user.email],
      );
      await event(id, 'created', req.user.email);
      await audit(id, 'created', `NDA created: ${n.data.company.legalName}`, req.user.email);
      res.json(await shapeDetail(await loadNda(id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/nda/agreements/:id', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SEND))) return;
    try {
      const row = await loadForReq(req, res);
      if (!row) return;
      if (row.status !== 'draft') return res.status(409).json({ error: 'locked', message: 'Only a draft can be edited — cancel and duplicate to change a sent NDA.' });
      const n = normalize({ ...req.body, mode: row.mode });
      if (!n.ok) return res.status(400).json({ error: 'invalid', fields: n.errors });
      await pool.query(`UPDATE nda_agreements SET company = $2, email = $3, data = $4::jsonb, updated_at = NOW() WHERE id = $1 AND status = 'draft'`,
        [row.id, n.data.company.legalName, n.data.signer.email, JSON.stringify(n.data)]);
      await event(row.id, 'edited', req.user.email);
      res.json(await shapeDetail(await loadNda(row.id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/nda/agreements/:id/duplicate', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SEND))) return;
    try {
      const row = await loadForReq(req, res);
      if (!row) return;
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO nda_agreements (id, mode, company, email, data, created_by) SELECT $2, mode, company, email, data, $3 FROM nda_agreements WHERE id = $1`,
        [row.id, id, req.user.email],
      );
      await event(id, 'created', req.user.email, null, { duplicatedFrom: refOf(row.ref_no) });
      res.json(await shapeDetail(await loadNda(id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/nda/agreements/:id', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SEND))) return;
    try {
      const row = await loadForReq(req, res);
      if (!row) return;
      // Jamais un NDA signé (c'est la preuve) ni en cours de signature (on l'annule d'abord).
      if (!DELETABLE.includes(row.status)) return res.status(409).json({ error: 'not_deletable', message: 'Only draft, cancelled or declined NDAs can be deleted.' });
      await pool.query('DELETE FROM nda_agreements WHERE id = $1', [row.id]);
      await audit(row.id, 'deleted', `NDA ${refOf(row.ref_no)} deleted (${row.status}): ${row.company}`, req.user.email);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -------------------------------------------------------------------------
  // NDA de l'autre partie (mode « upload ») — PDF seulement, verrouillé à l'envoi.
  // -------------------------------------------------------------------------
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACH, files: 1 } });
  app.post('/api/nda/agreements/:id/attachments', authenticateToken, (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (10 MB max)' : err.message });
      next();
    });
  }, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SEND))) return;
    try {
      const row = await loadForReq(req, res);
      if (!row) return;
      if (row.status !== 'draft') return res.status(409).json({ error: 'locked' });
      if (row.mode !== 'upload') return res.status(400).json({ error: 'Attachments are only for an uploaded NDA' });
      if (!req.file) return res.status(400).json({ error: 'No file' });
      if (!req.file.buffer.slice(0, 5).equals(Buffer.from('%PDF-'))) return res.status(400).json({ error: 'PDF only' });
      if (!(await R.pageCount(req.file.buffer))) return res.status(400).json({ error: 'Unreadable or protected PDF' });
      const n = (await pool.query('SELECT COUNT(*)::int n FROM nda_attachments WHERE nda_id = $1', [row.id])).rows[0].n;
      if (n >= MAX_ATTACH_COUNT) return res.status(400).json({ error: `At most ${MAX_ATTACH_COUNT} documents` });
      const filename = String(req.file.originalname || 'NDA.pdf').replace(/[\r\n"\\/]/g, '_').slice(0, 150);
      await pool.query(`INSERT INTO nda_attachments (nda_id, filename, size_bytes, sha256, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.id, filename, req.file.size, sha256(req.file.buffer), req.file.buffer, req.user.email]);
      await event(row.id, 'attachment_added', req.user.email, null, { filename });
      res.json(await shapeDetail(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/nda/agreements/:id/attachments/:aid', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SEND))) return;
    try {
      const row = await loadForReq(req, res);
      if (!row) return;
      if (row.status !== 'draft') return res.status(409).json({ error: 'locked' });
      const del = await pool.query('DELETE FROM nda_attachments WHERE id = $1 AND nda_id = $2 RETURNING filename', [Number(req.params.aid) || 0, row.id]);
      if (del.rows[0]) await event(row.id, 'attachment_removed', req.user.email, null, { filename: del.rows[0].filename });
      res.json(await shapeDetail(row));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PDF : brouillon = rendu à la volée ; envoyé = octets figés ; `signed` = le NDA final.
  app.get('/api/nda/agreements/:id/pdf/:doc', authenticateToken, async (req, res) => {
    try {
      const row = await loadForReq(req, res);
      if (!row) return;
      const doc = req.params.doc;
      const fb = fileBase(row);
      if (doc === 'signed') {
        const r = await pool.query('SELECT signed_pdf FROM nda_agreements WHERE id = $1', [row.id]);
        if (!r.rows[0] || !r.rows[0].signed_pdf) return res.status(404).json({ error: 'Not signed yet' });
        return sendPdf(res, r.rows[0].signed_pdf, `Cluster_NDA_${fb}_signed.pdf`, false);
      }
      if (doc.startsWith('att-')) {
        const a = await pool.query('SELECT filename, data FROM nda_attachments WHERE id = $1 AND nda_id = $2', [Number(doc.slice(4)) || 0, row.id]);
        if (!a.rows[0]) return res.status(404).json({ error: 'Not found' });
        return sendPdf(res, a.rows[0].data, a.rows[0].filename);
      }
      if (doc !== 'nda') return res.status(404).json({ error: 'Unknown document' });
      if (row.status !== 'draft') {
        const r = await pool.query('SELECT unsigned_pdf FROM nda_agreements WHERE id = $1', [row.id]);
        if (r.rows[0] && r.rows[0].unsigned_pdf) return sendPdf(res, r.rows[0].unsigned_pdf, `Cluster_NDA_${fb}.pdf`);
      }
      sendPdf(res, await render(await snapOf(row)), `Cluster_NDA_${fb}.pdf`);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -------------------------------------------------------------------------
  // Envoi pour signature
  // -------------------------------------------------------------------------
  function newToken() {
    const raw = crypto.randomBytes(32).toString('base64url');
    return { raw, hash: sha256(raw), expires: new Date(Date.now() + TOKEN_DAYS * 86400000) };
  }
  // Expéditeur = la personne qui envoie (comme les RH) : « De » à son adresse si son domaine est
  // authentifié chez SendGrid, sinon l'adresse Sales Hub avec Répondre-à elle.
  function senderOpts(sender) {
    if (!sender || !sender.email) return {};
    const email = String(sender.email).toLowerCase();
    const name = String(sender.name || email).replace(/["<>\r\n]/g, '').slice(0, 80);
    const domain = email.split('@')[1] || '';
    const verified = String(process.env.HR_SENDER_DOMAINS || 'clustersystems.com').split(',').map((d) => d.trim().toLowerCase()).filter((d) => d && d !== 'none');
    if (verified.includes(domain)) return { from: `"${name}" <${email}>`, replyTo: email };
    const baseFrom = String(process.env.SMTP_FROM || process.env.SMTP_USER || '');
    const addr = (/<([^>]+)>/.exec(baseFrom) || [null, baseFrom])[1].trim();
    return addr ? { from: `"${name} (Cluster)" <${addr}>`, replyTo: email } : { replyTo: email };
  }
  async function mailParty(row, snap, rawToken) {
    const link = `${base()}/nda-sign?token=${encodeURIComponent(rawToken)}`;
    const m = E.signRequestEmail(mailShell, {
      lang: snap.nda.lang, firstName: snap.nda.signer.firstName, company: snap.nda.company.legalName,
      senderName: snap.sender.name, link, expiresDays: TOKEN_DAYS,
    });
    const r = await sendMail(snap.nda.signer.email, m.subject, m.html, senderOpts(snap.sender));
    return { link, mail: r };
  }

  app.post('/api/nda/agreements/:id/send', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SEND))) return;
    try {
      const row = await loadForReq(req, res);
      if (!row) return;
      if (row.status !== 'draft') return res.status(409).json({ error: 'Already sent' });
      const att = row.mode === 'upload' ? await attachmentsWithPages(row.id) : [];
      if (row.mode === 'upload' && !att.length) return res.status(400).json({ error: 'no_document', message: 'Attach the other party’s NDA (PDF) before sending.' });
      const snap = {
        ref: refOf(row.ref_no),
        sentOn: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }),
        nda: row.data,
        clusterSigner: signerFor(await readSigner(), row.data.lang),
        attachments: att,
        sender: { email: req.user.email, name: req.user.name || req.user.email },
      };
      const pdf = await render(snap);
      const hashes = { nda: { sha256: sha256(pdf), pages: await R.pageCount(pdf) } };
      const tok = newToken();
      const upd = await pool.query(
        `UPDATE nda_agreements SET status = 'sent', snapshot = $2::jsonb, unsigned_pdf = $3, doc_hashes = $4::jsonb,
           token_hash = $5, token_expires_at = $6, sent_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'draft' RETURNING id`,
        [row.id, JSON.stringify(snap), pdf, JSON.stringify(hashes), tok.hash, tok.expires],
      );
      if (!upd.rows[0]) return res.status(409).json({ error: 'Already sent' });
      const out = await mailParty(row, snap, tok.raw);
      await event(row.id, 'sent', req.user.email, null, { to: row.email, emailed: out.mail.sent, reason: out.mail.reason || null });
      await audit(row.id, 'sent', `NDA sent for signature: ${row.company} (${row.email})`, req.user.email);
      // Le lien n'est rendu que si le courriel n'est pas parti, pour le transmettre à la main.
      res.json({ ...(await shapeDetail(await loadNda(row.id))), emailed: out.mail.sent, link: out.mail.sent ? null : out.link });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/nda/agreements/:id/resend', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SEND))) return;
    try {
      const row = await loadForReq(req, res);
      if (!row) return;
      if (!['sent', 'viewed'].includes(row.status)) return res.status(409).json({ error: 'Nothing to resend' });
      const tok = newToken();
      await pool.query(`UPDATE nda_agreements SET token_hash = $2, token_expires_at = $3, updated_at = NOW() WHERE id = $1`, [row.id, tok.hash, tok.expires]);
      const out = await mailParty(row, row.snapshot, tok.raw);
      await event(row.id, 'resent', req.user.email, null, { to: row.email, emailed: out.mail.sent });
      res.json({ ...(await shapeDetail(await loadNda(row.id))), emailed: out.mail.sent, link: out.mail.sent ? null : out.link });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/nda/agreements/:id/cancel', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SEND))) return;
    try {
      const row = await loadForReq(req, res);
      if (!row) return;
      if (['completed', 'cancelled', 'draft'].includes(row.status)) return res.status(409).json({ error: 'Cannot cancel' });
      await pool.query(`UPDATE nda_agreements SET status = 'cancelled', cancelled_at = NOW(), token_hash = NULL, updated_at = NOW() WHERE id = $1`, [row.id]);
      await event(row.id, 'cancelled', req.user.email);
      await audit(row.id, 'cancelled', `NDA cancelled: ${row.company}`, req.user.email);
      res.json(await shapeDetail(await loadNda(row.id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // -------------------------------------------------------------------------
  // Contresignature par le signataire de Cluster → NDA final + copies
  // -------------------------------------------------------------------------
  async function buildSignedPackage(id) {
    const r = (await pool.query(`SELECT ref_no, company, email, created_by, snapshot, doc_hashes, party_sig, cluster_sig, sent_at, viewed_at
      FROM nda_agreements WHERE id = $1`, [id])).rows[0];
    const snap = r.snapshot;
    const sigs = { partySig: r.party_sig, clusterSig: r.cluster_sig };
    const signedPage = await render(snap, sigs);
    const documents = [];
    let parts = [signedPage];
    if (snap.nda.mode === 'upload') {
      const att = (await pool.query('SELECT filename, sha256, data FROM nda_attachments WHERE nda_id = $1 ORDER BY id', [id])).rows;
      for (const a of att) documents.push({ title: `${a.filename} — other party's NDA / NDA de l'autre partie`, sha256: a.sha256 });
      documents.push({ title: 'Signature page (unsigned original) / Page de signature (original non signé)', sha256: r.doc_hashes.nda.sha256, pages: r.doc_hashes.nda.pages });
      parts = [...att.map((a) => a.data), signedPage];
    } else {
      documents.push({ title: `Non-Disclosure Agreement / Entente de confidentialité — ${snap.nda.lang.toUpperCase()}, unsigned original / original non signé`, sha256: r.doc_hashes.nda.sha256, pages: r.doc_hashes.nda.pages });
    }
    const s = snap.nda.signer;
    const cert = await R.renderCertificate({
      ref: refOf(r.ref_no), company: r.company, documents, sentAt: r.sent_at, viewedAt: r.viewed_at, preparedBy: r.created_by,
      party: { name: `${s.firstName} ${s.lastName}`, title: r.party_sig.title || s.title, email: r.email, at: r.party_sig.at, typedName: r.party_sig.name, ip: r.party_sig.ip, ua: r.party_sig.ua },
      cluster: { name: r.cluster_sig.name, title: snap.clusterSigner.title, email: r.cluster_sig.email, at: r.cluster_sig.at, ip: r.cluster_sig.ip },
    });
    return R.mergePdfs([...parts, cert]);
  }

  app.post('/api/nda/agreements/:id/countersign', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SIGN))) return;
    try {
      const row = await loadForReq(req, res);
      if (!row) return;
      if (row.status !== 'party_signed') return res.status(409).json({ error: 'The other party has not signed yet' });
      const signer = row.snapshot.clusterSigner;
      if (!isSigner(req, signer)) return res.status(403).json({ error: 'not_signer', message: `Only ${signer.name} (${signer.email}) can countersign this NDA.` });
      if (!validSignature(req.body?.signature)) return res.status(400).json({ error: 'signature required' });
      const { ip } = clientIp(req);
      const sig = { name: signer.name, email: req.user.email, image: req.body.signature, at: new Date().toISOString(), ip };
      const upd = await pool.query(`UPDATE nda_agreements SET cluster_sig = $2::jsonb, updated_at = NOW() WHERE id = $1 AND status = 'party_signed' RETURNING id`,
        [row.id, JSON.stringify(sig)]);
      if (!upd.rows[0]) return res.status(409).json({ error: 'Already countersigned' });
      const pdf = await buildSignedPackage(row.id);
      await pool.query(`UPDATE nda_agreements SET status = 'completed', signed_pdf = $2, completed_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id, pdf]);
      await event(row.id, 'countersigned', req.user.email, ip, { name: signer.name });
      await audit(row.id, 'completed', `NDA fully signed: ${row.company}`, req.user.email);

      const snap = row.snapshot;
      const attachment = [{ filename: `Cluster_NDA_${fileBase(row)}_signed.pdf`, content: pdf, contentType: 'application/pdf' }];
      const mp = E.completedPartyEmail(mailShell, { lang: snap.nda.lang, firstName: snap.nda.signer.firstName, company: row.company });
      const toParty = await sendMail(row.email, mp.subject, mp.html, { attachments: attachment, ...senderOpts(snap.sender) });
      const internal = [...new Set([row.created_by, signer.email].filter(Boolean).map((e) => String(e).toLowerCase()))].filter((e) => e !== String(row.email).toLowerCase());
      if (internal.length) {
        const mi = E.completedInternalEmail(mailShell, { company: row.company, link: `${base()}/nda?id=${row.id}` });
        await sendMail(internal.join(','), mi.subject, mi.html, { attachments: attachment });
      }
      await event(row.id, 'copies_sent', 'system', null, { party: toParty.sent, internal: internal.length, to: internal });
      res.json({ ...(await shapeDetail(await loadNda(row.id))), emailed: toParty.sent });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // =========================================================================
  // PUBLIC — page de signature de l'autre partie (/nda-sign?token=…). Le jeton EST
  // l'autorisation. Limité en débit par adresse.
  // =========================================================================
  async function byToken(req, res) {
    const raw = String(req.params.token || '');
    if (rateLimited(`ndasign:${clientIp(req).ip}`, 60)) { res.status(429).json({ error: 'Too many requests' }); return null; }
    if (raw.length < 20 || raw.length > 100) { res.status(404).json({ error: 'invalid' }); return null; }
    await schema();
    const r = await pool.query(`SELECT id, ref_no, status, company, email, created_by, snapshot, doc_hashes, token_expires_at, viewed_at,
        party_signed_at, completed_at FROM nda_agreements WHERE token_hash = $1`, [sha256(raw)]);
    const row = r.rows[0];
    if (!row) { res.status(404).json({ error: 'invalid' }); return null; }
    if (row.status === 'cancelled') { res.status(410).json({ error: 'cancelled' }); return null; }
    if (['sent', 'viewed'].includes(row.status) && new Date(row.token_expires_at) < new Date()) { res.status(410).json({ error: 'expired' }); return null; }
    return row;
  }
  const publicDocs = (row) => {
    const s = row.snapshot;
    const docs = [];
    if (s.nda.mode === 'upload') for (const a of s.attachments || []) docs.push({ key: `att-${a.id}`, kind: 'attachment', title: a.filename.replace(/\.pdf$/i, ''), pages: a.pages || null });
    docs.push({ key: 'nda', kind: s.nda.mode === 'upload' ? 'sigpage' : 'nda', pages: row.doc_hashes && row.doc_hashes.nda ? row.doc_hashes.nda.pages : null });
    return docs;
  };

  app.get('/api/public/nda-sign/:token', async (req, res) => {
    try {
      const row = await byToken(req, res);
      if (!row) return;
      if (!row.viewed_at && row.status === 'sent') {
        const { ip } = clientIp(req);
        await pool.query(`UPDATE nda_agreements SET status = 'viewed', viewed_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'sent'`, [row.id]);
        await event(row.id, 'viewed', row.email, ip, { ua: String(req.headers['user-agent'] || '').slice(0, 300) });
      }
      const s = row.snapshot;
      res.json({
        ref: refOf(row.ref_no),
        status: row.status === 'sent' ? 'viewed' : row.status,
        firstName: s.nda.signer.firstName,
        name: `${s.nda.signer.firstName} ${s.nda.signer.lastName}`,
        title: s.nda.signer.title,
        company: row.company,
        lang: s.nda.lang,
        mode: s.nda.mode,
        clusterSigner: { name: s.clusterSigner.name, title: s.clusterSigner.title },
        senderName: s.sender ? s.sender.name : null,
        documents: publicDocs(row),
        signedAt: row.party_signed_at,
        completedAt: row.completed_at,
      });
    } catch (e) { res.status(500).json({ error: 'server' }); }
  });

  app.get('/api/public/nda-sign/:token/doc/:doc', async (req, res) => {
    try {
      const row = await byToken(req, res);
      if (!row) return;
      const doc = req.params.doc;
      if (doc === 'nda') {
        const r = await pool.query('SELECT unsigned_pdf FROM nda_agreements WHERE id = $1', [row.id]);
        if (!r.rows[0] || !r.rows[0].unsigned_pdf) return res.status(404).json({ error: 'Not found' });
        return sendPdf(res, r.rows[0].unsigned_pdf, `Cluster_NDA_${fileBase(row)}.pdf`);
      }
      if (doc.startsWith('att-')) {
        const aid = Number(doc.slice(4)) || 0;
        if (!(row.snapshot.attachments || []).some((a) => a.id === aid)) return res.status(404).json({ error: 'Not found' });
        const a = await pool.query('SELECT filename, data FROM nda_attachments WHERE id = $1 AND nda_id = $2', [aid, row.id]);
        if (!a.rows[0]) return res.status(404).json({ error: 'Not found' });
        return sendPdf(res, a.rows[0].data, a.rows[0].filename);
      }
      res.status(404).json({ error: 'Not found' });
    } catch (e) { res.status(500).json({ error: 'server' }); }
  });

  app.post('/api/public/nda-sign/:token/sign', async (req, res) => {
    try {
      const row = await byToken(req, res);
      if (!row) return;
      if (!['sent', 'viewed'].includes(row.status)) return res.status(409).json({ error: 'already_signed' });
      const typed = str(req.body?.fullName, 120);
      const title = str(req.body?.title, 120) || row.snapshot.nda.signer.title;
      if (!typed) return res.status(400).json({ error: 'name_required' });
      if (req.body?.consent !== true) return res.status(400).json({ error: 'consent_required' });
      if (!validSignature(req.body?.signature)) return res.status(400).json({ error: 'signature_required' });
      const { ip, chain } = clientIp(req);
      const ua = String(req.headers['user-agent'] || '').slice(0, 300);
      const sig = { name: typed, title, image: req.body.signature, at: new Date().toISOString(), ip, ipChain: chain, ua, consent: true };
      const upd = await pool.query(
        `UPDATE nda_agreements SET status = 'party_signed', party_sig = $2::jsonb, party_signed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status IN ('sent','viewed') RETURNING created_by`,
        [row.id, JSON.stringify(sig)],
      );
      if (!upd.rows[0]) return res.status(409).json({ error: 'already_signed' });
      await event(row.id, 'party_signed', row.email, ip, { typedName: typed, ua });
      await audit(row.id, 'party_signed', `NDA signed by ${typed} for ${row.company}`, row.email);
      // Avis au signataire de Cluster (celui de l'instantané) + à la personne qui a préparé le NDA.
      const to = [...new Set([row.snapshot.clusterSigner.email, upd.rows[0].created_by].filter(Boolean).map((e) => String(e).toLowerCase()))];
      if (to.length) {
        const m = E.countersignEmail(mailShell, { company: row.company, signerName: typed, link: `${base()}/nda?id=${row.id}` });
        await sendMail(to.join(','), m.subject, m.html);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'server' }); }
  });

  app.post('/api/public/nda-sign/:token/decline', async (req, res) => {
    try {
      const row = await byToken(req, res);
      if (!row) return;
      if (!['sent', 'viewed'].includes(row.status)) return res.status(409).json({ error: 'not_pending' });
      const reason = str(req.body?.reason, 1000);
      const { ip } = clientIp(req);
      const upd = await pool.query(
        `UPDATE nda_agreements SET status = 'declined', declined_at = NOW(), decline_reason = $2, token_hash = NULL, updated_at = NOW()
         WHERE id = $1 AND status IN ('sent','viewed') RETURNING created_by`,
        [row.id, reason || null],
      );
      if (!upd.rows[0]) return res.status(409).json({ error: 'not_pending' });
      await event(row.id, 'declined', row.email, ip, { reason: reason || null });
      await audit(row.id, 'declined', `NDA declined: ${row.company}`, row.email);
      if (upd.rows[0].created_by) {
        const s = row.snapshot.nda.signer;
        const m = E.declinedEmail(mailShell, { company: row.company, signerName: `${s.firstName} ${s.lastName}`, reason, link: `${base()}/nda?id=${row.id}` });
        await sendMail(upd.rows[0].created_by, m.subject, m.html);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'server' }); }
  });
}

module.exports = { registerNdaRoutes, ensureSchema, normalize };
