// ============================================================================
// Crédits de compensation marchand — couche HTTP.
//
// Le parcours (demande de David, 2026-09-29) :
//   1. le rep choisit le client dans les comptes Zoho Books, saisit le montant, la langue ;
//   2. il téléverse les pièces exigées par la clause 4 (facture de pénalité, preuve de paiement) ;
//   3. il envoie : le formulaire de David est rempli, figé, haché, et un lien personnel part au
//      client ;
//   4. le client lit et signe en ligne (page publique /credit-sign, sans session) ;
//   5. David approuve (credits:approve) → la note de crédit est créée dans Zoho Books.
//
// Statuts : draft → sent → viewed → signed → approved | rejected ; declined (le client refuse),
// cancelled (le rep annule), expired (lien périmé, réenvoyable).
//
// Signature : même méthode que la section RH — jeton aléatoire dont on ne garde que le SHA-256,
// valable 14 jours, PDF présenté FIGÉ et haché à l'envoi, certificat joint au PDF signé.
//
// Permissions : credits:send (ses dossiers), credits:view_all (tous), credits:approve (approuver).
// ============================================================================

const crypto = require('crypto');
const multer = require('multer');
const pdf = require('./pdf');
const { books: booksApi } = require('./books');

const PERM_SEND = 'credits:send';
const PERM_VIEW_ALL = 'credits:view_all';
const PERM_APPROVE = 'credits:approve';
const PERM_DELETE = 'credits:delete';  // supprimer un dossier envoyé, signé ou approuvé (un brouillon : son auteur)
const PERM_REPORT = 'credits:report';  // comptabilité : rapport mensuel des crédits approuvés, lecture seule

const TOKEN_DAYS = 14;
const COMMITMENT_MONTHS = 36; // clause 3 du formulaire
// Statuts Zentact qui signifient que le marchand a QUITTÉ Cluster. Un départ détecté avant la fin
// de l'engagement ouvre une alerte de reprise sur tout crédit APPROUVÉ de ce marchand.
const LEFT_ZENTACT = ['CLOSED'];
const MAX_AMOUNT = 1_000_000;
const MAX_DOC = 10 * 1024 * 1024;
const DOC_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const MAX_SIG_BYTES = 400 * 1024;
const MAX_CLIENT_DOCS = 8; // pièces que le client peut joindre lui-même depuis la page de signature
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Une colonne BYTEA revient en Buffer avec node-postgres, mais en Uint8Array avec d'autres pilotes :
// res.send() d'un Uint8Array l'enverrait en JSON. On normalise avant tout envoi ou hachage.
const asBuffer = (b) => (b == null ? null : Buffer.isBuffer(b) ? b : Buffer.from(b));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const clean = (v, max = 200) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Type RÉEL d'un fichier, lu dans ses premiers octets : le type annoncé par le navigateur se falsifie.
function sniffType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

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
  return buf.length > 1500 && buf.length < MAX_SIG_BYTES && buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function parseAmount(v) {
  const n = Number(String(v == null ? '' : v).replace(/[\s  $]/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null;
  return Math.round(n * 100) / 100;
}

function newRef() {
  const d = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }).replace(/-/g, '');
  return `MC-${d}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS merchant_credits (
      id               UUID PRIMARY KEY,
      ref              TEXT UNIQUE NOT NULL,
      status           TEXT NOT NULL DEFAULT 'draft',
      lang             TEXT NOT NULL DEFAULT 'fr',
      rep_email        TEXT NOT NULL,
      rep_name         TEXT,
      books_customer_id TEXT,
      legal_name       TEXT NOT NULL DEFAULT '',
      contact_person   TEXT NOT NULL DEFAULT '',
      phone            TEXT NOT NULL DEFAULT '',
      email            TEXT NOT NULL DEFAULT '',
      amount           NUMERIC(12,2) NOT NULL DEFAULT 0,
      note             TEXT,
      token_hash       TEXT,
      token_expires_at TIMESTAMPTZ,
      sent_at          TIMESTAMPTZ,
      viewed_at        TIMESTAMPTZ,
      unsigned_pdf     BYTEA,
      unsigned_sha     TEXT,
      signed_at        TIMESTAMPTZ,
      signature        JSONB,
      signed_pdf       BYTEA,
      signed_sha       TEXT,
      commitment_end   DATE,
      decline_reason   TEXT,
      approved_by      TEXT,
      approved_at      TIMESTAMPTZ,
      rejected_by      TEXT,
      rejected_at      TIMESTAMPTZ,
      reject_reason    TEXT,
      creditnote_id    TEXT,
      creditnote_number TEXT,
      books_error      TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Le dossier part d'un marchand ZENTACT (demande de David, 2026-09-29) ; le compte Zoho Books,
  // nécessaire à la note de crédit, est relié ensuite (au plus tard à l'approbation).
  await pool.query('ALTER TABLE merchant_credits ADD COLUMN IF NOT EXISTS zentact_merchant_id TEXT');
  await pool.query('ALTER TABLE merchant_credits ADD COLUMN IF NOT EXISTS books_customer_name TEXT');
  // Reprise (clause 3) : le marchand quitte Cluster avant la fin de l'engagement de 36 mois.
  // clawback_status : NULL (rien à signaler) → 'flagged' (départ détecté) → 'reclaimed' | 'waived'.
  for (const col of ['clawback_status TEXT', 'clawback_flagged_at TIMESTAMPTZ', 'clawback_alerted_at TIMESTAMPTZ',
    'clawback_zentact_status TEXT', 'clawback_decided_by TEXT', 'clawback_decided_at TIMESTAMPTZ', 'clawback_note TEXT']) {
    await pool.query(`ALTER TABLE merchant_credits ADD COLUMN IF NOT EXISTS ${col}`);
  }
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS merchant_credits_token ON merchant_credits (token_hash) WHERE token_hash IS NOT NULL');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS merchant_credit_docs (
      id          SERIAL PRIMARY KEY,
      credit_id   UUID NOT NULL REFERENCES merchant_credits(id) ON DELETE CASCADE,
      filename    TEXT NOT NULL,
      mime        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      sha256      TEXT NOT NULL,
      data        BYTEA NOT NULL,
      uploaded_by TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

// Ce que l'écran reçoit : jamais les PDF ni le jeton.
const LIST_COLS = `id, ref, status, lang, rep_email, rep_name, books_customer_id, zentact_merchant_id, legal_name, contact_person, phone, email,
  amount, note, token_expires_at, sent_at, viewed_at, signed_at,
  -- DATE en texte : un objet Date passerait par minuit UTC et reculerait d'un jour à Montréal.
  to_char(commitment_end, 'YYYY-MM-DD') AS commitment_end, decline_reason, approved_by, approved_at,
  rejected_by, rejected_at, reject_reason, creditnote_id, creditnote_number, books_error, created_at, updated_at,
  clawback_status, clawback_flagged_at, clawback_zentact_status, clawback_decided_by, clawback_decided_at, clawback_note,
  (signature->>'name') AS signer_name, (signature->>'title') AS signer_title,
  (SELECT COUNT(*)::int FROM merchant_credit_docs d WHERE d.credit_id = merchant_credits.id) AS doc_count`;

function shape(r) {
  return {
    id: r.id, ref: r.ref, status: r.status, lang: r.lang,
    repEmail: r.rep_email, repName: r.rep_name,
    customerId: r.books_customer_id, merchantId: r.zentact_merchant_id, legalName: r.legal_name, contactPerson: r.contact_person,
    phone: r.phone, email: r.email, amount: Number(r.amount), note: r.note,
    tokenExpiresAt: r.token_expires_at, sentAt: r.sent_at, viewedAt: r.viewed_at, signedAt: r.signed_at,
    signerName: r.signer_name, signerTitle: r.signer_title, commitmentEnd: r.commitment_end,
    declineReason: r.decline_reason, approvedBy: r.approved_by, approvedAt: r.approved_at,
    rejectedBy: r.rejected_by, rejectedAt: r.rejected_at, rejectReason: r.reject_reason,
    creditnoteId: r.creditnote_id, creditnoteNumber: r.creditnote_number, booksError: r.books_error,
    docCount: r.doc_count, createdAt: r.created_at, updatedAt: r.updated_at,
    clawback: r.clawback_status ? {
      status: r.clawback_status, flaggedAt: r.clawback_flagged_at, zentactStatus: r.clawback_zentact_status,
      decidedBy: r.clawback_decided_by, decidedAt: r.clawback_decided_at, note: r.clawback_note,
    } : null,
  };
}

function registerCreditRoutes(app, deps) {
  const { authenticateToken, requirePerm, hasPerm, pool, logActivity, sendMail, mailShell, rateLimited, getAdminBooksAuth } = deps;
  // deps.books : un faux client Zoho pour les tests ; en production, le vrai.
  const zb = deps.books || booksApi(getAdminBooksAuth);
  const frontend = () => process.env.FRONTEND_URL || 'https://saleshub.clusterpos.com';
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOC, files: 1 } });

  let ready = null;
  const schema = () => (ready = ready || ensureSchema(pool).catch((e) => { ready = null; throw e; }));
  if (pool) schema().catch((e) => console.error('merchant_credits schema:', e.message));

  const isAdmin = (req) => req.user && req.user.isAdmin === true;
  const can = async (req, perm) => isAdmin(req) || (await hasPerm(req, perm).catch(() => false));
  const email = (req) => String((req.user && req.user.email) || '').toLowerCase();

  // Voir un dossier : le sien, ou view_all / approve.
  async function canSee(req, row) {
    if (row.rep_email.toLowerCase() === email(req)) return true;
    if ((await can(req, PERM_VIEW_ALL)) || (await can(req, PERM_APPROVE))) return true;
    return row.status === 'approved' && (await can(req, PERM_REPORT));
  }
  // Modifier / envoyer / téléverser : l'auteur (avec credits:send), ou un approbateur.
  async function canEdit(req, row) {
    if (row.rep_email.toLowerCase() === email(req)) return can(req, PERM_SEND);
    return can(req, PERM_APPROVE);
  }

  async function loadFor(req, res, { edit = false } = {}) {
    if (!UUID_RE.test(req.params.id || '')) { res.status(404).json({ error: 'not_found' }); return null; }
    await schema();
    const { rows } = await pool.query('SELECT * FROM merchant_credits WHERE id = $1', [req.params.id]);
    const row = rows[0];
    if (!row || !(await canSee(req, row))) { res.status(404).json({ error: 'not_found' }); return null; }
    if (edit && !(await canEdit(req, row))) { res.status(403).json({ error: 'forbidden' }); return null; }
    return row;
  }

  async function reload(id) {
    const { rows } = await pool.query(`SELECT ${LIST_COLS} FROM merchant_credits WHERE id = $1`, [id]);
    return rows[0] ? shape(rows[0]) : null;
  }

  // Noms des pièces jointes, imprimés dans la clause 4 du document.
  const docNames = async (id) => (await pool.query(
    'SELECT filename FROM merchant_credit_docs WHERE credit_id = $1 ORDER BY uploaded_at, id', [id])).rows.map((r) => r.filename);
  const pdfOpts = async (id) => ({ docs: await docNames(id), commitmentMonths: COMMITMENT_MONTHS });

  const log = (row, event, desc, actor, extra) =>
    logActivity('merchant_credit', row.id, event, `${row.ref} — ${desc}`, actor, extra).catch(() => {});

  // Destinataires de l'avis « dossier signé, à approuver » : les usagers dont un rôle porte
  // credits:approve (ou '*'), plus les admins. Au pire la liste est vide : le dossier reste
  // visible dans l'écran, avec son statut « À approuver ».
  async function approverEmails() {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT LOWER(ur.user_email) AS e FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE r.permissions ? $1 OR r.permissions ? '*'
         UNION
         SELECT DISTINCT LOWER(email) FROM user_tokens WHERE is_admin = true`, [PERM_APPROVE]);
      return rows.map((r) => r.e).filter((e) => EMAIL_RE.test(e));
    } catch (e) { console.error('credits approvers:', e.message); return []; }
  }

  // Expéditeur : le rep, comme pour les RH (domaine authentifié chez SendGrid ou Répondre à).
  function senderOpts(row) {
    const addr = String(row.rep_email || '').toLowerCase();
    const name = String(row.rep_name || addr).replace(/["<>\r\n]/g, '').slice(0, 80);
    const domain = addr.split('@')[1] || '';
    const verified = String(process.env.HR_SENDER_DOMAINS || 'clustersystems.com').split(',').map((d) => d.trim().toLowerCase()).filter((d) => d && d !== 'none');
    if (verified.includes(domain)) return { from: `"${name}" <${addr}>`, replyTo: addr };
    const baseFrom = String(process.env.SMTP_FROM || process.env.SMTP_USER || '');
    const fromAddr = (/<([^>]+)>/.exec(baseFrom) || [null, baseFrom])[1].trim();
    return fromAddr ? { from: `"${name} (Cluster)" <${fromAddr}>`, replyTo: addr } : { replyTo: addr };
  }

  // ── Écran interne ────────────────────────────────────────────────────────────────────
  app.get('/api/credits/meta', authenticateToken, async (req, res) => {
    const [send, viewAll, approve, del, report] = await Promise.all([can(req, PERM_SEND), can(req, PERM_VIEW_ALL), can(req, PERM_APPROVE), can(req, PERM_DELETE), can(req, PERM_REPORT)]);
    if (!send && !viewAll && !approve && !report) return res.status(403).json({ error: `Permission required: ${PERM_SEND}` });
    // Le rapport est ouvert à la comptabilité (credits:report) ET aux approbateurs.
    res.json({ canSend: send, canViewAll: viewAll, canApprove: approve, canDelete: del, canReport: report || approve, commitmentMonths: COMMITMENT_MONTHS });
  });

  // Statuts Zentact exclus : un marchand fermé, refusé ou révoqué ne reçoit plus de crédit. Ceux
  // en cours d'intégration restent proposés : le crédit est souvent offert AU moment du transfert.
  const DEAD_ZENTACT = ['CLOSED', 'REJECTED', 'APPLICATION_REVOKED', 'INVITE_REVOKED', 'INVITE_EXPIRED'];
  const shapeMerchant = (m) => ({ id: m.merchant_account_id, name: m.business_name || '', email: m.invitee_email || '', status: m.status || '', rep: m.sales_rep_name || '' });
  const likeArg = (q) => `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

  app.get('/api/credits/merchants', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SEND))) return;
    const q = clean(req.query.q, 80);
    if (q.length < 2) return res.json({ merchants: [] });
    try {
      const { rows } = await pool.query(
        `SELECT merchant_account_id, business_name, invitee_email, status, sales_rep_name FROM zentact_merchants
          WHERE NOT (status = ANY($2::text[])) AND (business_name ILIKE $1 OR merchant_account_id ILIKE $1)
          ORDER BY business_name LIMIT 25`, [likeArg(q), DEAD_ZENTACT]);
      res.json({ merchants: rows.map(shapeMerchant) });
    } catch (e) { console.error('credits merchants:', e.message); res.status(500).json({ error: 'load_failed' }); }
  });

  async function zentactMerchant(id) {
    if (!id || String(id).length > 255) return null;
    const { rows } = await pool.query(
      'SELECT merchant_account_id, business_name, invitee_email, status, sales_rep_name FROM zentact_merchants WHERE merchant_account_id = $1', [String(id)]);
    return rows[0] || null;
  }

  // Comptes Zoho Books : pour RELIER le dossier au compte qui recevra la note de crédit.
  app.get('/api/credits/customers', authenticateToken, async (req, res) => {
    if (!(await can(req, PERM_SEND)) && !(await can(req, PERM_APPROVE))) return res.status(403).json({ error: `Permission required: ${PERM_SEND}` });
    const q = clean(req.query.q, 80);
    if (q.length < 2) return res.json({ customers: [] });
    try { res.json({ customers: await zb.searchCustomers(q) }); }
    catch (e) { console.error('credits customers:', e.message); res.status(502).json({ error: 'books_unavailable', message: e.message }); }
  });

  app.get('/api/credits/customers/:cid', authenticateToken, async (req, res) => {
    if (!(await can(req, PERM_SEND)) && !(await can(req, PERM_APPROVE))) return res.status(403).json({ error: `Permission required: ${PERM_SEND}` });
    if (!/^\d{1,30}$/.test(req.params.cid)) return res.status(400).json({ error: 'bad_id' });
    try { res.json({ customer: await zb.getCustomer(req.params.cid) }); }
    catch (e) { console.error('credits customer:', e.message); res.status(502).json({ error: 'books_unavailable', message: e.message }); }
  });

  app.get('/api/credits', authenticateToken, async (req, res) => {
    const [send, viewAll, approve] = await Promise.all([can(req, PERM_SEND), can(req, PERM_VIEW_ALL), can(req, PERM_APPROVE)]);
    if (!send && !viewAll && !approve) return res.status(403).json({ error: `Permission required: ${PERM_SEND}` });
    try {
      await schema();
      const all = viewAll || approve;
      const { rows } = await pool.query(
        `SELECT ${LIST_COLS} FROM merchant_credits ${all ? '' : 'WHERE LOWER(rep_email) = $1'} ORDER BY updated_at DESC LIMIT 500`,
        all ? [] : [email(req)]);
      res.json({ credits: rows.map(shape) });
    } catch (e) { console.error('credits list:', e.message); res.status(500).json({ error: 'load_failed' }); }
  });

  function readFields(body) {
    const b = body || {};
    const out = {
      legal_name: clean(b.legalName), contact_person: clean(b.contactPerson), phone: clean(b.phone, 40),
      email: clean(b.email, 160).toLowerCase(), lang: b.lang === 'en' ? 'en' : 'fr', note: clean(b.note, 1000),
      zentact_merchant_id: b.merchantId ? clean(b.merchantId, 255) : null,
    };
    const amount = parseAmount(b.amount);
    return { out, amount };
  }

  app.post('/api/credits', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SEND))) return;
    const { out, amount } = readFields(req.body);
    try {
      await schema();
      if (!(await zentactMerchant(out.zentact_merchant_id))) return res.status(400).json({ error: 'merchant_required' });
      const id = crypto.randomUUID();
      const ref = newRef();
      await pool.query(
        `INSERT INTO merchant_credits (id, ref, status, lang, rep_email, rep_name, zentact_merchant_id, legal_name, contact_person, phone, email, amount, note)
         VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, ref, out.lang, email(req), req.user.name || email(req), out.zentact_merchant_id, out.legal_name, out.contact_person, out.phone, out.email, amount || 0, out.note || null]);
      await log({ id, ref }, 'created', `brouillon créé pour ${out.legal_name}`, email(req), { amount: amount || 0 });
      res.json({ credit: await reload(id) });
    } catch (e) { console.error('credits create:', e.message); res.status(500).json({ error: 'save_failed' }); }
  });

  app.put('/api/credits/:id', authenticateToken, async (req, res) => {
    const row = await loadFor(req, res, { edit: true }); if (!row) return;
    // Après l'envoi, le document présenté au client est figé : on ne le modifie plus en silence.
    if (row.status !== 'draft') return res.status(409).json({ error: 'not_draft' });
    const { out, amount } = readFields(req.body);
    try {
      if (out.zentact_merchant_id && !(await zentactMerchant(out.zentact_merchant_id))) return res.status(400).json({ error: 'merchant_required' });
      await pool.query(
        `UPDATE merchant_credits SET lang=$2, zentact_merchant_id=COALESCE($3, zentact_merchant_id), legal_name=$4, contact_person=$5,
                phone=$6, email=$7, amount=$8, note=$9, updated_at=NOW() WHERE id=$1`,
        [row.id, out.lang, out.zentact_merchant_id, out.legal_name, out.contact_person, out.phone, out.email, amount || 0, out.note || null]);
      res.json({ credit: await reload(row.id) });
    } catch (e) { console.error('credits update:', e.message); res.status(500).json({ error: 'save_failed' }); }
  });

  // ── Rapport mensuel pour la comptabilité ──
  // ⚠️ Déclaré AVANT `/api/credits/:id` : Express prendrait « report » pour un identifiant.
  // Les crédits APPROUVÉS pendant le mois (heure de Montréal), avec le compte Books, la note de
  // crédit et l'état de la reprise ; plus les reprises tranchées pendant ce mois. Lecture seule.
  const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
  async function reportData(month) {
    const range = `$1::timestamp AT TIME ZONE 'America/Toronto'`;
    const until = `($1::timestamp + INTERVAL '1 month') AT TIME ZONE 'America/Toronto'`;
    const start = `${month}-01 00:00:00`;
    const [approved, clawbacks, months] = await Promise.all([
      pool.query(
        `SELECT id, ref, legal_name, books_customer_id, books_customer_name, amount, creditnote_number, books_error, rep_name, rep_email,
                approved_by, to_char(approved_at AT TIME ZONE 'America/Toronto', 'YYYY-MM-DD') AS approved_day,
                to_char(commitment_end, 'YYYY-MM-DD') AS commitment_end, clawback_status
           FROM merchant_credits
          WHERE status = 'approved' AND approved_at >= ${range} AND approved_at < ${until}
          ORDER BY approved_at`, [start]),
      pool.query(
        `SELECT id, ref, legal_name, amount, creditnote_number, clawback_status, clawback_decided_by, clawback_note,
                to_char(clawback_decided_at AT TIME ZONE 'America/Toronto', 'YYYY-MM-DD') AS decided_day
           FROM merchant_credits
          WHERE clawback_status IN ('reclaimed', 'waived') AND clawback_decided_at >= ${range} AND clawback_decided_at < ${until}
          ORDER BY clawback_decided_at`, [start]),
      pool.query(
        `SELECT DISTINCT to_char(approved_at AT TIME ZONE 'America/Toronto', 'YYYY-MM') AS m
           FROM merchant_credits WHERE status = 'approved' AND approved_at IS NOT NULL ORDER BY 1 DESC LIMIT 36`),
    ]);
    const rows = approved.rows.map((r) => ({
      id: r.id, ref: r.ref, legalName: r.legal_name, booksCustomerId: r.books_customer_id, booksCustomerName: r.books_customer_name,
      amount: Number(r.amount), creditnoteNumber: r.creditnote_number, booksError: r.books_error ? true : false,
      rep: r.rep_name || r.rep_email, approvedBy: r.approved_by, approvedDay: r.approved_day, commitmentEnd: r.commitment_end, clawback: r.clawback_status,
    }));
    const cents = (xs) => Math.round(xs.reduce((a, x) => a + Math.round(Number(x) * 100), 0)) / 100;
    const reclaimed = clawbacks.rows.filter((r) => r.clawback_status === 'reclaimed');
    return {
      month,
      months: months.rows.map((r) => r.m),
      rows,
      clawbacks: clawbacks.rows.map((r) => ({ id: r.id, ref: r.ref, legalName: r.legal_name, amount: Number(r.amount), creditnoteNumber: r.creditnote_number,
        decision: r.clawback_status, decidedBy: r.clawback_decided_by, decidedDay: r.decided_day, note: r.clawback_note })),
      totals: {
        count: rows.length,
        amount: cents(rows.map((r) => r.amount)),
        withCreditNote: rows.filter((r) => r.creditnoteNumber).length,
        pendingCreditNote: rows.filter((r) => !r.creditnoteNumber).length,
        reclaimedCount: reclaimed.length,
        reclaimedAmount: cents(reclaimed.map((r) => r.amount)),
      },
    };
  }

  async function reportAccess(req, res) {
    if ((await can(req, PERM_REPORT)) || (await can(req, PERM_APPROVE))) return true;
    res.status(403).json({ error: `Permission required: ${PERM_REPORT}` });
    return false;
  }

  app.get('/api/credits/report', authenticateToken, async (req, res) => {
    if (!(await reportAccess(req, res))) return;
    const month = String(req.query.month || '');
    if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'bad_month' });
    try { await schema(); res.json(await reportData(month)); } catch (e) { console.error('credits report:', e.message); res.status(500).json({ error: 'report_failed' }); }
  });

  // CSV pour Excel : BOM UTF-8 ; en français, « ; » et virgule décimale (réglages régionaux fr-CA).
  app.get('/api/credits/report.csv', authenticateToken, async (req, res) => {
    if (!(await reportAccess(req, res))) return;
    const month = String(req.query.month || '');
    if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'bad_month' });
    const en = req.query.lang === 'en';
    try {
      await schema();
      const d = await reportData(month);
      const sep = en ? ',' : ';';
      // Une cellule qui commence par = + - @ serait lue comme une FORMULE par Excel : on la neutralise.
      const cell = (v) => {
        let t = v == null ? '' : String(v);
        if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
        return t.includes(sep) || /["\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      const num = (v) => (en ? Number(v).toFixed(2) : Number(v).toFixed(2).replace('.', ','));
      const H = en
        ? ['Approved on', 'Reference', 'Merchant', 'Zoho Books account', 'Books account #', 'Amount (CAD)', 'Credit note', 'Rep', 'Approved by', 'Commitment end', 'Clawback']
        : ['Approuvé le', 'Référence', 'Marchand', 'Compte Zoho Books', 'No compte Books', 'Montant (CAD)', 'Note de crédit', 'Représentant', 'Approuvé par', "Fin de l'engagement", 'Reprise'];
      const CB = en ? { flagged: 'possible', reclaimed: 'reclaimed', waived: 'waived' } : { flagged: 'possible', reclaimed: 'reprise', waived: 'abandonnée' };
      const lines = [H.map(cell).join(sep)];
      for (const r of d.rows) {
        lines.push([r.approvedDay, r.ref, r.legalName, r.booksCustomerName || '', r.booksCustomerId || '', num(r.amount),
          r.creditnoteNumber || (en ? 'TO CREATE' : 'À CRÉER'), r.rep, r.approvedBy, r.commitmentEnd || '', r.clawback ? CB[r.clawback] || r.clawback : ''].map(cell).join(sep));
      }
      lines.push([en ? 'Total' : 'Total', '', `${d.totals.count}`, '', '', num(d.totals.amount)].map(cell).join(sep));
      if (d.clawbacks.length) {
        lines.push('');
        lines.push([en ? 'Clawbacks decided this month' : 'Reprises tranchées ce mois-ci'].map(cell).join(sep));
        lines.push((en ? ['Decided on', 'Reference', 'Merchant', 'Amount (CAD)', 'Credit note', 'Decision', 'Decided by', 'Note'] : ['Tranché le', 'Référence', 'Marchand', 'Montant (CAD)', 'Note de crédit', 'Décision', 'Par', 'Note']).map(cell).join(sep));
        for (const r of d.clawbacks) lines.push([r.decidedDay, r.ref, r.legalName, num(r.amount), r.creditnoteNumber || '', CB[r.decision] || r.decision, r.decidedBy, r.note || ''].map(cell).join(sep));
      }
      const name = `${en ? 'merchant-processor-credits' : 'credits-processeur-marchand'}-${month}.csv`;
      res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}"`)
        .send('\ufeff' + lines.join('\r\n') + '\r\n');
    } catch (e) { console.error('credits report csv:', e.message); res.status(500).json({ error: 'report_failed' }); }
  });

  app.get('/api/credits/:id', authenticateToken, async (req, res) => {
    const row = await loadFor(req, res); if (!row) return;
    const { rows: docs } = await pool.query(
      'SELECT id, filename, mime, size, sha256, uploaded_by, uploaded_at FROM merchant_credit_docs WHERE credit_id = $1 ORDER BY uploaded_at', [row.id]);
    const { rows: events } = await pool.query(
      `SELECT event_type, description, actor, created_at FROM activity_log WHERE entity_type = 'merchant_credit' AND entity_id = $1 ORDER BY created_at`, [row.id]).catch(() => ({ rows: [] }));
    const [canApprove, canEditIt] = await Promise.all([can(req, PERM_APPROVE), canEdit(req, row)]);
    res.json({
      credit: await reload(row.id),
      docs: docs.map((d) => ({ id: d.id, filename: d.filename, mime: d.mime, size: d.size, sha256: d.sha256, uploadedBy: d.uploaded_by, uploadedAt: d.uploaded_at })),
      events: events.map((e) => ({ type: e.event_type, description: e.description, actor: e.actor, at: e.created_at })),
      canApprove, canEdit: canEditIt,
    });
  });

  // PDF : le signé s'il existe, sinon celui envoyé, sinon un aperçu du brouillon.
  app.get('/api/credits/:id/pdf', authenticateToken, async (req, res) => {
    const row = await loadFor(req, res); if (!row) return;
    try {
      const buf = asBuffer(row.signed_pdf || row.unsigned_pdf) || (await pdf.renderUnsigned(row, await pdfOpts(row.id)));
      res.set('Content-Type', 'application/pdf').set('Content-Disposition', `inline; filename="${row.ref}.pdf"`).send(buf);
    } catch (e) { console.error('credits pdf:', e.message); res.status(500).json({ error: 'pdf_failed' }); }
  });

  // ── Pièces justificatives (téléversées par le rep) ──
  const DOC_LOCKED = new Set(['approved', 'rejected', 'cancelled']);
  app.post('/api/credits/:id/docs', authenticateToken, (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'upload_failed' });
    next();
  }), async (req, res) => {
    const row = await loadFor(req, res, { edit: true }); if (!row) return;
    if (DOC_LOCKED.has(row.status)) return res.status(409).json({ error: 'locked' });
    const f = req.file;
    if (!f || !f.buffer || !f.buffer.length) return res.status(400).json({ error: 'no_file' });
    if (!DOC_TYPES.has(f.mimetype)) return res.status(400).json({ error: 'bad_type' });
    const filename = clean(f.originalname, 180).replace(/[\\/]/g, '_') || 'document';
    const { rows } = await pool.query(
      `INSERT INTO merchant_credit_docs (credit_id, filename, mime, size, sha256, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [row.id, filename, f.mimetype, f.buffer.length, sha256(f.buffer), f.buffer, email(req)]);
    await pool.query('UPDATE merchant_credits SET updated_at = NOW() WHERE id = $1', [row.id]);
    await log(row, 'doc_uploaded', `pièce ajoutée : ${filename}`, email(req));
    res.json({ id: rows[0].id });
  });

  app.get('/api/credits/:id/docs/:docId', authenticateToken, async (req, res) => {
    const row = await loadFor(req, res); if (!row) return;
    const { rows } = await pool.query('SELECT filename, mime, data FROM merchant_credit_docs WHERE id = $1 AND credit_id = $2', [Number(req.params.docId) || 0, row.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.set('Content-Type', rows[0].mime).set('Content-Disposition', `inline; filename="${encodeURIComponent(rows[0].filename)}"`).send(asBuffer(rows[0].data));
  });

  app.delete('/api/credits/:id/docs/:docId', authenticateToken, async (req, res) => {
    const row = await loadFor(req, res, { edit: true }); if (!row) return;
    if (DOC_LOCKED.has(row.status)) return res.status(409).json({ error: 'locked' });
    const r = await pool.query('DELETE FROM merchant_credit_docs WHERE id = $1 AND credit_id = $2 RETURNING filename', [Number(req.params.docId) || 0, row.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await log(row, 'doc_deleted', `pièce retirée : ${r.rows[0].filename}`, email(req));
    res.json({ ok: true });
  });

  // ── Envoi au client ──
  app.post('/api/credits/:id/send', authenticateToken, async (req, res) => {
    const row = await loadFor(req, res, { edit: true }); if (!row) return;
    if (!['draft', 'sent', 'viewed', 'expired'].includes(row.status)) return res.status(409).json({ error: 'not_sendable' });
    const missing = [];
    if (!row.zentact_merchant_id) missing.push('merchant');
    if (!row.legal_name) missing.push('legalName');
    if (!EMAIL_RE.test(row.email)) missing.push('email');
    if (!(Number(row.amount) > 0)) missing.push('amount');
    if (missing.length) return res.status(400).json({ error: 'incomplete', missing });
    try {
      // Premier envoi : on fige le document. Un renvoi réutilise le MÊME document (même empreinte).
      const unsigned = asBuffer(row.unsigned_pdf) || (await pdf.renderUnsigned(row, await pdfOpts(row.id)));
      const raw = crypto.randomBytes(32).toString('base64url');
      const expires = new Date(Date.now() + TOKEN_DAYS * 86400000);
      await pool.query(
        `UPDATE merchant_credits SET status = CASE WHEN status = 'viewed' THEN 'viewed' ELSE 'sent' END,
                unsigned_pdf = $2, unsigned_sha = $3, token_hash = $4, token_expires_at = $5,
                sent_at = COALESCE(sent_at, NOW()), updated_at = NOW() WHERE id = $1`,
        [row.id, unsigned, sha256(unsigned), sha256(Buffer.from(raw)), expires]);
      const link = `${frontend()}/credit-sign?token=${raw}`;
      const fr = row.lang !== 'en';
      const amount = `${pdf.formatAmount(row.amount, row.lang)} $ CAD`;
      const title = fr ? 'Votre crédit de compensation Cluster' : 'Your Cluster Compensation Credit';
      const intro = fr
        ? `Bonjour${row.contact_person ? ` ${esc(row.contact_person)}` : ''},<br><br>${esc(row.rep_name || 'Votre représentant Cluster')} vous offre un crédit de compensation de <b>${esc(amount)}</b> pour ${esc(row.legal_name)}, afin de couvrir la pénalité de résiliation de votre processeur de paiement actuel.<br><br>Veuillez compléter l'entente et la signer en ligne ; vous pouvez aussi y joindre les pièces justificatives. Le lien est personnel et valable ${TOKEN_DAYS} jours.`
        : `Hello${row.contact_person ? ` ${esc(row.contact_person)}` : ''},<br><br>${esc(row.rep_name || 'Your Cluster representative')} is offering a compensation credit of <b>${esc(amount)}</b> to ${esc(row.legal_name)}, to cover the termination penalty from your current payment processor.<br><br>Please complete the agreement and sign it online; you can also attach the supporting documents there. This link is personal and valid for ${TOKEN_DAYS} days.`;
      const html = mailShell(title, intro, fr ? 'Lire et signer' : 'Review and sign', link, row.lang, 'cluster');
      const r = await sendMail(row.email, title, html, senderOpts(row));
      if (!r || !r.sent) {
        await log(row, 'send_failed', `envoi échoué (${(r && r.reason) || 'inconnu'})`, email(req));
        return res.status(502).json({ error: 'mail_failed', reason: r && r.reason });
      }
      await log(row, row.sent_at ? 'resent' : 'sent', `envoyé à ${row.email}`, email(req), { amount: Number(row.amount) });
      res.json({ credit: await reload(row.id) });
    } catch (e) { console.error('credits send:', e.message); res.status(500).json({ error: 'send_failed' }); }
  });

  app.post('/api/credits/:id/cancel', authenticateToken, async (req, res) => {
    const row = await loadFor(req, res, { edit: true }); if (!row) return;
    if (['approved', 'rejected', 'cancelled'].includes(row.status)) return res.status(409).json({ error: 'locked' });
    await pool.query(`UPDATE merchant_credits SET status = 'cancelled', token_hash = NULL, updated_at = NOW() WHERE id = $1`, [row.id]);
    await log(row, 'cancelled', 'dossier annulé', email(req));
    res.json({ credit: await reload(row.id) });
  });

  // Brouillon seulement : un dossier envoyé laisse une trace (on l'annule, on ne l'efface pas).
  // Brouillon : son auteur (ou un approbateur) le supprime librement. Tout autre statut exige
  // credits:delete ET une raison, parce qu'on efface une entente envoyée ou signée. Le journal
  // d'activité garde la trace (référence, marchand, montant, note de crédit) : il survit au dossier.
  // ⚠️ La note de crédit Zoho n'est PAS supprimée (Sales Hub n'a pas ce droit chez Zoho) : la
  // réponse la nomme pour que l'écran demande de l'annuler dans Zoho Books.
  app.delete('/api/credits/:id', authenticateToken, async (req, res) => {
    const draft = await (async () => {
      if (!UUID_RE.test(req.params.id || '')) return null;
      await schema();
      return (await pool.query('SELECT status FROM merchant_credits WHERE id = $1', [req.params.id])).rows[0] || null;
    })();
    if (draft && draft.status === 'draft') {
      const row = await loadFor(req, res, { edit: true }); if (!row) return;
      await pool.query('DELETE FROM merchant_credits WHERE id = $1', [row.id]);
      await log(row, 'deleted', 'brouillon supprimé', email(req));
      return res.json({ ok: true, creditnoteNumber: null });
    }
    if (!(await requirePerm(req, res, PERM_DELETE))) return;
    const row = await loadFor(req, res); if (!row) return;
    const reason = clean((req.body || {}).reason, 500);
    if (reason.length < 3) return res.status(400).json({ error: 'reason_required' });
    const del = await pool.query('DELETE FROM merchant_credits WHERE id = $1 AND status = $2 RETURNING id', [row.id, row.status]);
    if (!del.rows[0]) return res.status(409).json({ error: 'changed' });
    await log(row, 'deleted',
      `dossier supprimé (${row.status}) — ${row.legal_name}, ${pdf.formatAmount(row.amount, 'fr')} $${row.creditnote_number ? `, note de crédit ${row.creditnote_number} (à annuler dans Zoho Books)` : ''} — raison : ${reason}`,
      email(req), { amount: Number(row.amount) });
    res.json({ ok: true, creditnoteNumber: row.creditnote_number || null });
  });


  // ── Approbation → note de crédit Zoho Books ──
  async function pushToBooks(row, actor) {
    const r = await zb.createCreditNote({ customerId: row.books_customer_id, amount: row.amount, ref: row.ref, lang: row.lang, legalName: row.legal_name })
      .catch((e) => ({ ok: false, message: e.message }));
    if (r.ok) {
      await pool.query('UPDATE merchant_credits SET creditnote_id=$2, creditnote_number=$3, books_error=NULL, updated_at=NOW() WHERE id=$1', [row.id, r.id, r.number]);
      await log(row, 'creditnote_created', `note de crédit ${r.number || r.id} créée dans Zoho Books`, actor, { amount: Number(row.amount) });
    } else {
      const msg = r.scopeMissing
        ? `Zoho Books refuse (${r.message}). Reconnectez Zoho Books pour accorder la permission « creditnotes.CREATE », puis réessayez.`
        : `Zoho Books : ${r.message}`;
      await pool.query('UPDATE merchant_credits SET books_error=$2, updated_at=NOW() WHERE id=$1', [row.id, msg.slice(0, 500)]);
      await log(row, 'creditnote_failed', msg.slice(0, 300), actor);
    }
    return r;
  }

  // Relie le dossier au compte Zoho Books qui recevra la note de crédit. Vérifié chez Zoho (le
  // compte doit exister) ; possible jusqu'à l'approbation, par l'auteur ou un approbateur.
  app.post('/api/credits/:id/books-customer', authenticateToken, async (req, res) => {
    const row = await loadFor(req, res); if (!row) return;
    if (!(await canEdit(req, row)) && !(await can(req, PERM_APPROVE))) return res.status(403).json({ error: 'forbidden' });
    if (['approved', 'rejected', 'cancelled'].includes(row.status)) return res.status(409).json({ error: 'locked' });
    const cid = String((req.body || {}).customerId || '');
    if (!/^\d{1,30}$/.test(cid)) return res.status(400).json({ error: 'bad_id' });
    let cust;
    try { cust = await zb.getCustomer(cid); } catch (e) { return res.status(502).json({ error: 'books_unavailable', message: e.message }); }
    await pool.query('UPDATE merchant_credits SET books_customer_id=$2, books_customer_name=$3, updated_at=NOW() WHERE id=$1', [row.id, cid, cust.legalName || null]);
    await log(row, 'books_linked', `relié au compte Zoho Books « ${cust.legalName} » (#${cid})`, email(req));
    res.json({ credit: await reload(row.id) });
  });

  app.post('/api/credits/:id/approve', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_APPROVE))) return;
    const row = await loadFor(req, res); if (!row) return;
    if (row.status !== 'signed') return res.status(409).json({ error: 'not_signed' });
    if (!row.books_customer_id) return res.status(400).json({ error: 'books_customer_required' });
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM merchant_credit_docs WHERE credit_id = $1', [row.id]);
    if (!n) return res.status(400).json({ error: 'docs_required' });
    // Verrou : un double clic ou deux approbateurs simultanés ne créent pas DEUX notes de crédit.
    const upd = await pool.query(
      `UPDATE merchant_credits SET status='approved', approved_by=$2, approved_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='signed' RETURNING *`,
      [row.id, email(req)]);
    if (!upd.rows[0]) return res.status(409).json({ error: 'not_signed' });
    await log(row, 'approved', `approuvé (${pdf.formatAmount(row.amount, 'fr')} $)`, email(req), { amount: Number(row.amount) });
    const r = await pushToBooks(upd.rows[0], email(req));
    res.json({ credit: await reload(row.id), books: r.ok ? { ok: true, number: r.number } : { ok: false } });
  });

  app.post('/api/credits/:id/retry-books', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_APPROVE))) return;
    const row = await loadFor(req, res); if (!row) return;
    if (row.status !== 'approved' || row.creditnote_id) return res.status(409).json({ error: 'nothing_to_retry' });
    const r = await pushToBooks(row, email(req));
    res.json({ credit: await reload(row.id), books: r.ok ? { ok: true, number: r.number } : { ok: false } });
  });

  app.post('/api/credits/:id/reject', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_APPROVE))) return;
    const row = await loadFor(req, res); if (!row) return;
    if (row.status !== 'signed') return res.status(409).json({ error: 'not_signed' });
    const reason = clean((req.body || {}).reason, 500);
    if (!reason) return res.status(400).json({ error: 'reason_required' });
    await pool.query(`UPDATE merchant_credits SET status='rejected', rejected_by=$2, rejected_at=NOW(), reject_reason=$3, updated_at=NOW() WHERE id=$1`, [row.id, email(req), reason]);
    await log(row, 'rejected', `refusé : ${reason}`, email(req));
    if (EMAIL_RE.test(row.rep_email)) {
      const html = mailShell(`Crédit ${row.ref} refusé`, `Le crédit de ${esc(pdf.formatAmount(row.amount, 'fr'))} $ pour ${esc(row.legal_name)} a été refusé.<br><br>Raison : ${esc(reason)}`, 'Ouvrir le dossier', `${frontend()}/credits?id=${row.id}`, 'fr');
      await sendMail(row.rep_email, `Crédit ${row.ref} refusé`, html).catch(() => {});
    }
    res.json({ credit: await reload(row.id) });
  });

  // ── Reprise avant 36 mois (clause 3) ──
  // Appelée chaque jour par le worker (server.js) et à la demande. Idempotente : un dossier n'est
  // signalé qu'une fois, et l'avis n'est envoyé qu'une fois (clawback_alerted_at).
  async function checkClawbacks() {
    await schema();
    const { rows: flagged } = await pool.query(
      `UPDATE merchant_credits mc SET clawback_status = 'flagged', clawback_flagged_at = NOW(),
              clawback_zentact_status = z.status, updated_at = NOW()
         FROM zentact_merchants z
        WHERE z.merchant_account_id = mc.zentact_merchant_id
          AND mc.status = 'approved' AND mc.clawback_status IS NULL
          AND mc.commitment_end > CURRENT_DATE
          AND z.status = ANY($1::text[])
        RETURNING mc.*`, [LEFT_ZENTACT]);
    for (const row of flagged) {
      await log(row, 'clawback_flagged', `reprise possible : le marchand est ${row.clawback_zentact_status} dans Zentact avant la fin de l'engagement`, 'system', { amount: Number(row.amount) });
    }
    const { rows: pending } = await pool.query(
      `SELECT * FROM merchant_credits WHERE clawback_status = 'flagged' AND clawback_alerted_at IS NULL ORDER BY clawback_flagged_at`);
    if (pending.length) {
      const to = [...new Set([...(await approverEmails()), ...pending.map((r) => String(r.rep_email).toLowerCase())])].filter((e) => EMAIL_RE.test(e));
      if (to.length) {
        const lines = pending.map((r) => `<li><b>${esc(r.legal_name)}</b> — ${esc(r.ref)} — ${esc(pdf.formatAmount(r.amount, 'fr'))} $ (engagement jusqu'au ${esc(String(r.commitment_end instanceof Date ? r.commitment_end.toISOString().slice(0, 10) : r.commitment_end).slice(0, 10))})</li>`).join('');
        const title = pending.length === 1 ? 'Reprise possible d\'un crédit processeur marchand' : `Reprise possible de ${pending.length} crédits processeur marchand`;
        const intro = `Ces marchands sont fermés dans Zentact avant la fin de leur engagement de ${COMMITMENT_MONTHS} mois. Selon la clause 3, Cluster peut reprendre le crédit :<ul>${lines}</ul>Ouvrez chaque dossier pour noter la décision (crédit repris ou pas de reprise).`;
        const r = await sendMail(to.join(','), title, mailShell(title, intro, 'Ouvrir les crédits', `${frontend()}/credits?filter=clawback`, 'fr')).catch(() => null);
        if (!r || !r.sent) { console.warn('[credits] avis de reprise non envoyé :', r && r.reason); return { flagged: flagged.length, alerted: 0 }; }
      }
      await pool.query(`UPDATE merchant_credits SET clawback_alerted_at = NOW() WHERE id = ANY($1::uuid[])`, [pending.map((r) => r.id)]);
    }
    return { flagged: flagged.length, alerted: pending.length };
  }

  app.post('/api/credits/clawback-check', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_APPROVE))) return;
    try { res.json(await checkClawbacks()); } catch (e) { console.error('credits clawback:', e.message); res.status(500).json({ error: 'check_failed' }); }
  });

  app.post('/api/credits/:id/clawback', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_APPROVE))) return;
    const row = await loadFor(req, res); if (!row) return;
    if (row.clawback_status !== 'flagged') return res.status(409).json({ error: 'no_clawback' });
    const decision = (req.body || {}).decision;
    if (!['reclaimed', 'waived'].includes(decision)) return res.status(400).json({ error: 'bad_decision' });
    const note = clean((req.body || {}).note, 500);
    await pool.query(
      `UPDATE merchant_credits SET clawback_status=$2, clawback_decided_by=$3, clawback_decided_at=NOW(), clawback_note=$4, updated_at=NOW() WHERE id=$1`,
      [row.id, decision, email(req), note || null]);
    await log(row, `clawback_${decision}`, `${decision === 'reclaimed' ? 'crédit repris' : 'pas de reprise'}${note ? ` : ${note}` : ''}`, email(req), { amount: Number(row.amount) });
    res.json({ credit: await reload(row.id) });
  });

  // ── Page de signature PUBLIQUE (aucune session : le jeton est l'autorisation) ──
  async function byToken(req, res) {
    const raw = String(req.params.token || '');
    if (rateLimited(`creditsign:${clientIp(req).ip}`, 60)) { res.status(429).json({ error: 'rate_limited' }); return null; }
    if (raw.length < 20 || raw.length > 100) { res.status(404).json({ error: 'invalid' }); return null; }
    await schema();
    const { rows } = await pool.query('SELECT * FROM merchant_credits WHERE token_hash = $1', [sha256(Buffer.from(raw))]);
    const row = rows[0];
    if (!row) { res.status(404).json({ error: 'invalid' }); return null; }
    if (row.status === 'cancelled') { res.status(410).json({ error: 'cancelled' }); return null; }
    const done = ['signed', 'approved', 'rejected'].includes(row.status);
    if (!done && row.status !== 'declined' && row.token_expires_at && new Date(row.token_expires_at) < new Date()) {
      if (row.status !== 'expired') await pool.query(`UPDATE merchant_credits SET status='expired', updated_at=NOW() WHERE id=$1`, [row.id]);
      res.status(410).json({ error: 'expired' }); return null;
    }
    return row;
  }

  const publicInfo = (row) => ({
    ref: row.ref, lang: row.lang, status: ['signed', 'approved', 'rejected'].includes(row.status) ? 'signed' : row.status,
    legalName: row.legal_name, contactPerson: row.contact_person, phone: row.phone, email: row.email,
    amount: Number(row.amount), repName: row.rep_name, signedAt: row.signed_at, commitmentMonths: COMMITMENT_MONTHS,
  });

  // Ce que le CLIENT remplit sur la page : les infos du marchand. Le montant reste celui que Cluster
  // offre (le rep le fixe) ; le client ne le modifie pas.
  function clientFields(b) {
    const f = {
      legal_name: clean(b.legalName), contact_person: clean(b.contactPerson), phone: clean(b.phone, 40),
      email: clean(b.email, 160).toLowerCase(),
    };
    const missing = [];
    if (f.legal_name.length < 2) missing.push('legalName');
    if (f.contact_person.length < 2) missing.push('contactPerson');
    if (f.phone.replace(/\D/g, '').length < 7) missing.push('phone');
    if (!EMAIL_RE.test(f.email)) missing.push('email');
    return { f, missing };
  }

  const publicDocs = async (row) => (await pool.query(
    `SELECT id, filename, size, uploaded_at FROM merchant_credit_docs WHERE credit_id = $1 AND uploaded_by = 'client' ORDER BY uploaded_at`, [row.id])).rows
    .map((d) => ({ id: d.id, filename: d.filename, size: d.size }));

  app.get('/api/public/credit-sign/:token', async (req, res) => {
    const row = await byToken(req, res); if (!row) return;
    if (row.status === 'sent') {
      await pool.query(`UPDATE merchant_credits SET status='viewed', viewed_at=COALESCE(viewed_at, NOW()), updated_at=NOW() WHERE id=$1`, [row.id]);
      await log(row, 'viewed', 'ouvert par le client', 'client');
      row.status = 'viewed';
    }
    res.json({ ...publicInfo(row), docs: await publicDocs(row) });
  });

  // Aperçu : le formulaire rempli avec ce que le client vient de saisir, avant qu'il signe.
  app.post('/api/public/credit-sign/:token/preview', async (req, res) => {
    const row = await byToken(req, res); if (!row) return;
    if (!['sent', 'viewed'].includes(row.status)) return res.status(409).json({ error: 'not_signable' });
    const { f } = clientFields(req.body || {});
    try {
      const buf = await pdf.renderUnsigned({ ...row, ...f }, await pdfOpts(row.id));
      res.set('Content-Type', 'application/pdf').set('Content-Disposition', `inline; filename="${row.ref}.pdf"`).send(buf);
    } catch (e) { console.error('credits preview:', e.message); res.status(500).json({ error: 'pdf_failed' }); }
  });

  // Pièces justificatives jointes par le CLIENT (clause 4). Mêmes règles que pour le rep, plus :
  // type vérifié dans les octets, nombre plafonné, retrait possible de SES pièces seulement.
  app.post('/api/public/credit-sign/:token/docs', (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'upload_failed' });
    next();
  }), async (req, res) => {
    const row = await byToken(req, res); if (!row) return;
    if (!['sent', 'viewed'].includes(row.status)) return res.status(409).json({ error: 'not_signable' });
    const f = req.file;
    if (!f || !f.buffer || !f.buffer.length) return res.status(400).json({ error: 'no_file' });
    const mime = sniffType(f.buffer);
    if (!mime) return res.status(400).json({ error: 'bad_type' });
    const n = (await pool.query(`SELECT COUNT(*)::int AS n FROM merchant_credit_docs WHERE credit_id = $1 AND uploaded_by = 'client'`, [row.id])).rows[0].n;
    if (n >= MAX_CLIENT_DOCS) return res.status(400).json({ error: 'too_many' });
    const filename = clean(f.originalname, 180).replace(/[\\/]/g, '_') || 'document';
    await pool.query(
      `INSERT INTO merchant_credit_docs (credit_id, filename, mime, size, sha256, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,'client')`,
      [row.id, filename, mime, f.buffer.length, sha256(f.buffer), f.buffer]);
    await pool.query('UPDATE merchant_credits SET updated_at = NOW() WHERE id = $1', [row.id]);
    await log(row, 'doc_uploaded', `pièce ajoutée par le client : ${filename}`, 'client');
    res.json({ docs: await publicDocs(row) });
  });

  app.delete('/api/public/credit-sign/:token/docs/:docId', async (req, res) => {
    const row = await byToken(req, res); if (!row) return;
    if (!['sent', 'viewed'].includes(row.status)) return res.status(409).json({ error: 'not_signable' });
    const r = await pool.query(`DELETE FROM merchant_credit_docs WHERE id = $1 AND credit_id = $2 AND uploaded_by = 'client' RETURNING filename`,
      [Number(req.params.docId) || 0, row.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    await log(row, 'doc_deleted', `pièce retirée par le client : ${r.rows[0].filename}`, 'client');
    res.json({ docs: await publicDocs(row) });
  });

  app.get('/api/public/credit-sign/:token/pdf', async (req, res) => {
    const row = await byToken(req, res); if (!row) return;
    const buf = asBuffer(row.signed_pdf || row.unsigned_pdf);
    if (!buf) return res.status(404).json({ error: 'not_found' });
    res.set('Content-Type', 'application/pdf').set('Content-Disposition', `inline; filename="${row.ref}.pdf"`).send(buf);
  });

  app.post('/api/public/credit-sign/:token/sign', async (req, res) => {
    let row = await byToken(req, res); if (!row) return;
    if (!['sent', 'viewed'].includes(row.status)) return res.status(409).json({ error: 'not_signable' });
    const b = req.body || {};
    const name = clean(b.printName, 120);
    const title = clean(b.title, 120);
    if (!name || name.length < 2) return res.status(400).json({ error: 'name_required' });
    if (!title) return res.status(400).json({ error: 'title_required' });
    if (b.consent !== true) return res.status(400).json({ error: 'consent_required' });
    if (!validSignature(b.signature)) return res.status(400).json({ error: 'signature_invalid' });
    const { f, missing } = clientFields(b);
    if (missing.length) return res.status(400).json({ error: 'incomplete', missing });
    const { ip, chain } = clientIp(req);
    const sig = { name, title, image: b.signature, at: new Date().toISOString(), ip, ipChain: chain, ua: clean(req.headers['user-agent'], 300), consent: true };
    try {
      // Le document que le client a CONFIRMÉ = le formulaire rempli avec SES valeurs ; c'est lui qu'on
      // fige et dont l'empreinte figure au certificat.
      const merged = { ...row, ...f };
      const opts = await pdfOpts(row.id);
      const confirmed = await pdf.renderUnsigned(merged, opts);
      const confirmedSha = sha256(confirmed);
      const signed = await pdf.renderSigned(merged, sig, confirmedSha, opts);
      // Verrou : deux envois simultanés du formulaire ne signent pas deux fois.
      const upd = await pool.query(
        `UPDATE merchant_credits SET status='signed', signed_at=NOW(), signature=$2::jsonb, signed_pdf=$3, signed_sha=$4,
                unsigned_pdf=$5, unsigned_sha=$6, legal_name=$7, contact_person=$8, phone=$9, email=$10,
                commitment_end = (NOW() + INTERVAL '${COMMITMENT_MONTHS} months')::date, updated_at=NOW()
          WHERE id=$1 AND status IN ('sent','viewed') RETURNING *`,
        [row.id, JSON.stringify(sig), signed, sha256(signed), confirmed, confirmedSha, f.legal_name, f.contact_person, f.phone, f.email]);
      if (!upd.rows[0]) return res.status(409).json({ error: 'not_signable' });
      // Ce que le client a changé par rapport à ce que le rep avait prérempli : tracé.
      const LBL = { legal_name: 'nom légal', contact_person: 'personne-ressource', phone: 'téléphone', email: 'courriel' };
      const changed = Object.keys(LBL).filter((k) => String(row[k] || '') !== f[k]).map((k) => `${LBL[k]} : « ${row[k] || '—'} » → « ${f[k]} »`);
      if (changed.length) await log(row, 'client_edited', `infos complétées par le client — ${changed.join(' ; ')}`, 'client');
      await log(row, 'signed', `signé par ${name} (${title})`, 'client', { amount: Number(row.amount) });
      const origEmail = String(row.email || '').toLowerCase();
      row = upd.rows[0];

      const fr = row.lang !== 'en';
      const attach = [{ filename: `${row.ref}.pdf`, content: signed, contentType: 'application/pdf' }];
      // Copie au client.
      const ct = fr ? 'Votre entente signée' : 'Your signed agreement';
      const ci = fr
        ? `Merci ${esc(name)}. Vous trouverez ci-joint votre entente de crédit de compensation signée (${esc(row.ref)}). Le crédit sera appliqué à votre compte Cluster après vérification des documents.`
        : `Thank you ${esc(name)}. Attached is your signed Compensation Credit agreement (${esc(row.ref)}). The credit will be applied to your Cluster account once the documents are verified.`;
      const copyTo = [...new Set([row.email, origEmail])].filter((e) => EMAIL_RE.test(e));
      await sendMail(copyTo.join(','), ct, mailShell(ct, ci, null, null, row.lang, 'cluster'), { ...senderOpts(row), attachments: attach }).catch(() => {});
      // Avis interne : le rep + les approbateurs.
      const internal = [...new Set([String(row.rep_email).toLowerCase(), ...(await approverEmails())])].filter((e) => EMAIL_RE.test(e));
      if (internal.length) {
        const it = `Crédit ${row.ref} signé — à approuver`;
        const ii = `${esc(row.legal_name)} a signé l'entente de crédit de <b>${esc(pdf.formatAmount(row.amount, 'fr'))} $</b> (signataire : ${esc(name)}, ${esc(title)}).<br><br>Le dossier attend l'approbation ; la note de crédit sera alors créée dans Zoho Books.`;
        await sendMail(internal.join(','), it, mailShell(it, ii, 'Ouvrir le dossier', `${frontend()}/credits?id=${row.id}`, 'fr'), { attachments: attach }).catch(() => {});
      }
      res.json(publicInfo(upd.rows[0]));
    } catch (e) { console.error('credits sign:', e.message); res.status(500).json({ error: 'sign_failed' }); }
  });

  app.post('/api/public/credit-sign/:token/decline', async (req, res) => {
    const row = await byToken(req, res); if (!row) return;
    if (!['sent', 'viewed'].includes(row.status)) return res.status(409).json({ error: 'not_signable' });
    const reason = clean((req.body || {}).reason, 500);
    await pool.query(`UPDATE merchant_credits SET status='declined', decline_reason=$2, token_hash=NULL, updated_at=NOW() WHERE id=$1`, [row.id, reason || null]);
    await log(row, 'declined', `refusé par le client${reason ? ` : ${reason}` : ''}`, 'client');
    if (EMAIL_RE.test(row.rep_email)) {
      const html = mailShell(`Crédit ${row.ref} décliné par le client`, `${esc(row.legal_name)} a décliné l'entente de crédit.${reason ? `<br><br>Raison : ${esc(reason)}` : ''}`, 'Ouvrir le dossier', `${frontend()}/credits?id=${row.id}`, 'fr');
      await sendMail(row.rep_email, `Crédit ${row.ref} décliné`, html).catch(() => {});
    }
    res.json({ status: 'declined' });
  });

  return { checkClawbacks };
}

module.exports = { registerCreditRoutes, PERM_SEND, PERM_VIEW_ALL, PERM_APPROVE, PERM_DELETE, PERM_REPORT, LEFT_ZENTACT, parseAmount, validSignature };
