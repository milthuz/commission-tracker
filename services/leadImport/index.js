// ============================================================================
// Import d'une liste de SALON dans les pistes (2026-10-09, demande de David après le salon GFS).
//
// Monté par UNE ligne dans server.js (comme services/webflowLeads). Permission `leads:import`.
//
// Trois temps, décidés par David :
//   1. APERÇU — le fichier est lu, regroupé (une personne = une piste, voir parse.js) et chaque
//      ligne est vérifiée contre Zoho (doublon) et contre les pistes déjà reçues. Rien n'est créé :
//      le lot est gardé en brouillon (`lead_import_batches`).
//   2. EXAMEN EN LOT — l'écran montre tout ; on décoche, on change le rep d'une ligne, puis on
//      accepte le lot. Chaque ligne cochée devient une piste (source 'event') immédiatement
//      ACCEPTÉE par le même acceptLead() que la file : Lead Zoho au nom du rep. SANS rappel
//      (c'est le visiteur qui choisit son moment), sans le courriel de bienvenue « on vous appelle
//      d'ici une heure », et UN SEUL courriel récapitulatif par rep au lieu d'un par piste.
//      La règle « rien n'entre dans Zoho sans examen humain » tient : l'examen, c'est cet écran.
//   3. COURRIEL — aperçu (EN/FR), test envoyé à soi-même, puis envoi au lot : remerciement de
//      visite + bouton /rdv pour planifier une rencontre avec le rep (emails.eventThanksEmail).
//
// 🔑 Rejouable sans dégât : une piste porte `external_ref = import:<lot>:<clé>` (index unique
// déjà posé par webflowLeads) ; réaccepter un lot ne recrée rien et reprend une piste que Zoho
// avait refusée. Un courriel parti est marqué (`merchant_notified_at`) et ne repart pas.
// ============================================================================

const multer = require('multer');
const { parseLeadWorkbook, leadNotes } = require('./parse');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const crypto = require('crypto');
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// L'adresse PUBLIQUE de l'API : l'image du courriel est chargée par le client de courriel du
// visiteur, directement chez nous.
const apiBase = () => process.env.BACKEND_URL || process.env.PUBLIC_API_URL || 'https://commission-tracker-production-b7f9.up.railway.app';
const MAX_ROWS = 300;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function registerLeadImportRoutes(app, deps) {
  const { authenticateToken, requirePerm, pool, logActivity } = deps;
  const h = () => deps.late();

  let schemaReady = null;
  function ensureSchema() {
    if (!schemaReady) {
      schemaReady = (async () => {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS lead_import_batches (
            id          SERIAL PRIMARY KEY,
            file_name   VARCHAR(255),
            event_name  VARCHAR(160),
            language    VARCHAR(5) DEFAULT 'en',
            zoho_source VARCHAR(120),
            default_rep VARCHAR(255),
            status      VARCHAR(20) DEFAULT 'draft',
            rows        JSONB NOT NULL DEFAULT '[]',
            summary     JSONB,
            created_by  VARCHAR(255),
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            accepted_at TIMESTAMP,
            emailed_at  TIMESTAMP
          )`);
        await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS import_batch_id INTEGER`);
        // La photo du kiosque (2026-10-09) : gardée DANS la base comme les Ressources (aucun stockage
        // objet), servie publiquement sous un jeton aléatoire — un client de courriel ne s'authentifie pas.
        await pool.query(`ALTER TABLE lead_import_batches ADD COLUMN IF NOT EXISTS photo BYTEA`);
        await pool.query(`ALTER TABLE lead_import_batches ADD COLUMN IF NOT EXISTS photo_type VARCHAR(40)`);
        await pool.query(`ALTER TABLE lead_import_batches ADD COLUMN IF NOT EXISTS photo_token VARCHAR(64)`);
        await pool.query(`ALTER TABLE lead_import_batches ADD COLUMN IF NOT EXISTS photo_caption VARCHAR(200)`);
        await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_ref VARCHAR(160)`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_external_ref ON leads(external_ref) WHERE external_ref IS NOT NULL`);
      })().catch((e) => { schemaReady = null; throw e; });
    }
    return schemaReady;
  }
  setTimeout(() => ensureSchema().catch((e) => console.warn('[import-pistes] schéma pas encore prêt :', e.message)), 15000);

  const actorOf = (req) => req.user.realAdminEmail || req.user.email || 'unknown';

  // Le lot + l'état de chacune de ses pistes déjà créées.
  async function loadBatch(id) {
    const b = (await pool.query(
      `SELECT id, file_name, event_name, language, zoho_source, default_rep, status, rows, summary, created_by,
              created_at, accepted_at, emailed_at, photo_token, photo_caption FROM lead_import_batches WHERE id = $1`, [id])).rows[0];
    if (!b) return null;
    b.photoUrl = b.photo_token ? `${apiBase()}/api/public/lead-import-photo/${b.photo_token}` : null;
    delete b.photo_token;
    const leads = (await pool.query(
      `SELECT id, ref_code, external_ref, status, assigned_rep_name, crm_lead_id, crm_lead_error,
              merchant_notified_at, contact_email, automation
         FROM leads WHERE import_batch_id = $1`, [id])).rows;
    const byKey = new Map(leads.map((l) => [String(l.external_ref || '').replace(`import:${id}:`, ''), l]));
    const rows = (b.rows || []).map((r) => {
      const l = byKey.get(r.key);
      return { ...r, lead: l ? {
        id: l.id, refCode: l.ref_code, status: l.status, rep: l.assigned_rep_name,
        crmLeadId: l.crm_lead_id, crmError: l.crm_lead_error,
        emailedAt: l.merchant_notified_at, emailError: l.automation?.eventThanks?.ok === false ? l.automation.eventThanks.error : null,
      } : null };
    });
    return { ...b, rows };
  }

  // Les reps proposables, avec l'adresse que l'envoi utilisera : un rep sans adresse ne peut ni
  // signer le courriel ni ouvrir son agenda — l'écran doit le montrer AVANT l'envoi.
  async function repOptions() {
    const names = (await pool.query(
      `SELECT name FROM salespeople WHERE is_active = true ORDER BY name`)).rows.map((r) => r.name);
    const out = [];
    for (const name of names) {
      const c = await h().leadRepContact(name);
      out.push({ name, email: c?.email || null, inZoho: !!c?.crmUserId });
    }
    return out;
  }

  // ── 1. Aperçu ─────────────────────────────────────────────────────────────
  app.post('/api/leads/import/preview', authenticateToken, upload.single('file'), async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:import'))) return;
    if (!req.file?.buffer) return res.status(400).json({ error: 'no_file' });
    try {
      await ensureSchema();
      const parsed = parseLeadWorkbook(req.file.buffer);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      if (parsed.leads.length > MAX_ROWS) return res.status(400).json({ error: 'too_many_rows', max: MAX_ROWS });

      // Doublons : Zoho (même fonction que la file des pistes) + pistes déjà reçues par courriel.
      // En série, volontairement : quelques centaines d'appels Zoho en parallèle déclencheraient
      // le plafond de l'API pour toute l'organisation.
      const emails = parsed.leads.map((l) => l.email).filter(Boolean);
      const local = emails.length ? (await pool.query(
        `SELECT DISTINCT ON (LOWER(contact_email)) LOWER(contact_email) AS email, ref_code, status, assigned_rep_name, source_detail
           FROM leads WHERE LOWER(contact_email) = ANY($1) ORDER BY LOWER(contact_email), created_at DESC`,
        [emails])).rows : [];
      const localBy = new Map(local.map((r) => [r.email, r]));
      for (const l of parsed.leads) {
        const dup = await h().checkCrmDuplicate({ businessName: l.businessName, contactEmail: l.email, contactPhone: l.phone })
          .catch((e) => ({ status: 'error', summary: e.message, matches: [] }));
        l.crm = { status: dup.status, summary: dup.summary || null,
                  matches: (dup.matches || []).slice(0, 3).map((m) => ({ module: m.module, name: m.name, owner: m.owner?.name || null, matchedOn: m.matchedOn || null })) };
        const loc = l.email ? localBy.get(l.email) : null;
        l.existingLead = loc ? { refCode: loc.ref_code, status: loc.status, rep: loc.assigned_rep_name, source: loc.source_detail } : null;
        // Défaut : coché, sauf ce qui ne peut pas recevoir le courriel, ce qui est déjà une piste,
        // et ce que Zoho connaît déjà — l'accepter créerait une SECONDE fiche ; on le coche en le voyant.
        l.include = !!l.email && !l.warnings.includes('bad_email') && !loc && l.crm.status !== 'match_found';
      }

      const b = (await pool.query(
        `INSERT INTO lead_import_batches (file_name, rows, created_by) VALUES ($1, $2::jsonb, $3) RETURNING id`,
        [String(req.file.originalname || '').slice(0, 255), JSON.stringify(parsed.leads), actorOf(req)])).rows[0];
      logActivity('lead_import', b.id, 'previewed',
        `Liste « ${req.file.originalname} » lue : ${parsed.lineCount} lignes → ${parsed.leads.length} pistes`, actorOf(req));
      res.json({ batch: await loadBatch(b.id), sheet: parsed.sheetName, lineCount: parsed.lineCount,
                 columns: parsed.columns, unmapped: parsed.unmapped, reps: await repOptions() });
    } catch (e) {
      console.error('[import-pistes] aperçu :', e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/leads/import/batches', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:import'))) return;
    try {
      await ensureSchema();
      const rows = (await pool.query(
        `SELECT b.id, b.file_name, b.event_name, b.status, b.created_by, b.created_at, b.accepted_at, b.emailed_at,
                jsonb_array_length(b.rows) AS row_count,
                (SELECT COUNT(*) FROM leads l WHERE l.import_batch_id = b.id AND l.status = 'accepted')::int AS accepted_count,
                (SELECT COUNT(*) FROM leads l WHERE l.import_batch_id = b.id AND l.merchant_notified_at IS NOT NULL)::int AS emailed_count
           FROM lead_import_batches b ORDER BY b.created_at DESC LIMIT 15`)).rows;
      res.json({ batches: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/leads/import/batches/:id', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:import'))) return;
    try {
      await ensureSchema();
      const b = await loadBatch(Number(req.params.id));
      if (!b) return res.status(404).json({ error: 'not_found' });
      res.json({ batch: b, reps: await repOptions() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 2. Accepter le lot ────────────────────────────────────────────────────
  // Corps : { eventName, language, zohoSource, defaultRep, rows: [{ key, include, repName }] }
  app.post('/api/leads/import/batches/:id/accept', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:import'))) return;
    const id = Number(req.params.id);
    const actor = actorOf(req);
    const body = req.body || {};
    const eventName = String(body.eventName || '').trim().slice(0, 160);
    const language = String(body.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
    const zohoSource = String(body.zohoSource || '').trim().slice(0, 120) || null;
    const defaultRep = String(body.defaultRep || '').trim();
    if (!eventName) return res.status(400).json({ error: 'event_name_required' });
    try {
      await ensureSchema();
      const batch = (await pool.query(`SELECT * FROM lead_import_batches WHERE id = $1`, [id])).rows[0];
      if (!batch) return res.status(404).json({ error: 'not_found' });
      const choices = new Map((Array.isArray(body.rows) ? body.rows : []).map((r) => [String(r.key), r]));
      // Les choix de l'écran sont GARDÉS sur le lot : le rouvrir montre ce qui a été décidé.
      const rows = (batch.rows || []).map((r) => {
        const c = choices.get(r.key);
        return c ? { ...r, include: !!c.include, repName: String(c.repName || '').trim() || null } : r;
      });
      const todo = rows.filter((r) => r.include);
      if (!todo.length) return res.status(400).json({ error: 'nothing_selected' });
      if (todo.some((r) => !(r.repName || defaultRep))) return res.status(400).json({ error: 'no_rep' });

      await pool.query(
        `UPDATE lead_import_batches SET rows = $2::jsonb, event_name = $3, language = $4, zoho_source = $5, default_rep = $6 WHERE id = $1`,
        [id, JSON.stringify(rows), eventName, language, zohoSource, defaultRep || null]);

      const results = [];
      for (const r of todo) {
        const ref = `import:${id}:${r.key}`.slice(0, 160);
        const repName = r.repName || defaultRep;
        try {
          let lead = (await pool.query(`SELECT id, ref_code, status FROM leads WHERE external_ref = $1`, [ref])).rows[0];
          if (!lead) {
            const input = h().normalizeLeadInput({
              businessName: r.businessName, contactFirstName: r.firstName, contactLastName: r.lastName,
              contactEmail: r.email, contactPhone: r.phone, city: r.city, province: r.province,
              postalCode: r.postalCode, businessType: r.businessType, website: r.website,
              language, notes: leadNotes(r, eventName),
            }, { source: 'event' });
            input.source = 'event';
            input.sourceDetail = eventName;
            const out = await h().createLeadRow(input, { createdBy: actor, raw: { import: { batchId: id, key: r.key, lines: r.lines } }, notifyReviewers: false });
            await pool.query(`UPDATE leads SET external_ref = $2, import_batch_id = $3 WHERE id = $1`, [out.id, ref, id]);
            lead = { id: out.id, ref_code: out.refCode, status: 'new' };
          }
          if (lead.status === 'accepted') { results.push({ key: r.key, refCode: lead.ref_code, ok: true, already: true }); continue; }
          const acc = await h().acceptLead(lead.id, actor, {
            repName,
            // Vu et laissé coché dans l'écran du lot : c'est la confirmation du doublon.
            confirmDuplicate: true,
            settingsOverride: {
              callbackEnabled: false, notifyMerchant: false, notifyRep: false, bookingEnabled: false,
              ...(zohoSource ? { leadSourceEvent: zohoSource } : {}),
              contactMethodEvent: 'Trade Show',
            },
          });
          results.push(acc.ok
            ? { key: r.key, refCode: lead.ref_code, ok: true, rep: acc.rep?.name, crmLeadId: acc.crmLeadId, retriedWithoutPicklists: !!acc.steps?.crmRetriedWithoutPicklists }
            : { key: r.key, refCode: lead.ref_code, ok: false, error: acc.error, detail: acc.detail || null });
        } catch (e) {
          results.push({ key: r.key, ok: false, error: 'exception', detail: e.message });
        }
      }

      // UN courriel par rep, au lieu d'un par piste : onze avis identiques d'affilée noient le seul
      // qui compte. Seulement pour les pistes nouvellement acceptées.
      const fresh = results.filter((x) => x.ok && !x.already);
      const byRep = new Map();
      for (const x of fresh) {
        const r = rows.find((y) => y.key === x.key);
        if (!byRep.has(x.rep)) byRep.set(x.rep, []);
        byRep.get(x.rep).push({ ...r, refCode: x.refCode });
      }
      const repMails = [];
      for (const [repName, list] of byRep) {
        const rep = await h().leadRepContact(repName);
        if (!rep?.email) { repMails.push({ rep: repName, ok: false, error: 'no_email' }); continue; }
        const m = await h().sendMail(rep.email, ...repSummaryEmail(h().mailShell, eventName, rep, list, h().base()));
        repMails.push({ rep: repName, to: rep.email, ok: !!m.sent, error: m.sent ? null : m.reason });
      }

      const summary = { at: new Date().toISOString(), by: actor, ok: results.filter((x) => x.ok).length,
                        failed: results.filter((x) => !x.ok).length, results, repMails };
      await pool.query(
        `UPDATE lead_import_batches SET status = $2, summary = $3::jsonb, accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP) WHERE id = $1`,
        [id, summary.failed ? 'partial' : 'accepted', JSON.stringify(summary)]);
      logActivity('lead_import', id, 'accepted',
        `Lot « ${eventName} » : ${summary.ok} pistes acceptées, ${summary.failed} en échec`, actor, { metadata: { repMails } });
      res.json({ summary, batch: await loadBatch(id) });
    } catch (e) {
      console.error('[import-pistes] acceptation :', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── La photo du kiosque ──────────────────────────────────────────────────
  // L'écran la réduit AVANT l'envoi (une photo de téléphone fait 4 Mo ; un courriel doit rester
  // léger). Nouvelle photo = nouveau jeton : un courriel déjà parti garde l'image qu'il montrait
  // seulement tant qu'on ne la remplace pas — d'où l'avertissement de l'écran après l'envoi.
  app.post('/api/leads/import/batches/:id/photo', authenticateToken, upload.single('photo'), async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:import'))) return;
    try {
      await ensureSchema();
      const id = Number(req.params.id);
      const caption = String(req.body?.caption || '').trim().slice(0, 200) || null;
      if (!req.file?.buffer) {
        // Seulement la légende.
        const r = await pool.query(`UPDATE lead_import_batches SET photo_caption = $2 WHERE id = $1`, [id, caption]);
        if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
        return res.json({ batch: await loadBatch(id) });
      }
      if (!PHOTO_TYPES.includes(req.file.mimetype)) return res.status(400).json({ error: 'bad_photo_type' });
      const token = crypto.randomBytes(24).toString('base64url');
      const r = await pool.query(
        `UPDATE lead_import_batches SET photo = $2, photo_type = $3, photo_token = $4, photo_caption = $5 WHERE id = $1`,
        [id, req.file.buffer, req.file.mimetype, token, caption]);
      if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
      logActivity('lead_import', id, 'photo_set', `Photo du kiosque ajoutée (${Math.round(req.file.size / 1024)} Ko)`, actorOf(req));
      res.json({ batch: await loadBatch(id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/leads/import/batches/:id/photo', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:import'))) return;
    try {
      await ensureSchema();
      const id = Number(req.params.id);
      await pool.query(`UPDATE lead_import_batches SET photo = NULL, photo_type = NULL, photo_token = NULL, photo_caption = NULL WHERE id = $1`, [id]);
      res.json({ batch: await loadBatch(id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUBLIQUE, sans authentification : c'est le client de courriel du visiteur qui la charge.
  // Le jeton aléatoire (24 octets) est la seule clé ; il ne dit rien du lot.
  app.get('/api/public/lead-import-photo/:token', async (req, res) => {
    try {
      await ensureSchema();
      const token = String(req.params.token || '').replace(/\.[a-z]+$/i, '');
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(404).end();
      const r = (await pool.query(`SELECT photo, photo_type FROM lead_import_batches WHERE photo_token = $1`, [token])).rows[0];
      if (!r?.photo) return res.status(404).end();
      res.set('Content-Type', r.photo_type || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      res.send(Buffer.from(r.photo));   // Buffer explicite : un Uint8Array partirait en JSON
    } catch { res.status(500).end(); }
  });

  // ── 3. Le courriel de remerciement ────────────────────────────────────────
  async function renderFor(batch, lead, bookingUrl) {
    const lang = lead.language === 'fr' ? 'fr' : 'en';
    const rep = await h().leadRepContact(lead.assigned_rep_name || batch.default_rep, { lang });
    const settings = await h().leadSettings();
    const mail = h().eventThanksEmail({
      lang,
      firstName: lead.contact_first_name || null,
      businessName: lead.business_name,
      eventName: batch.event_name,
      rep: rep ? { name: rep.name, email: rep.email, role: rep.signatureRole || null, phone: rep.signaturePhone || null } : null,
      bookingUrl,
      photoUrl: batch.photo_token ? `${apiBase()}/api/public/lead-import-photo/${batch.photo_token}` : null,
      photoCaption: batch.photo_caption || null,
      home: settings.merchantSiteUrl,
      signatureHtml: rep?.signatureHtml || '',
    });
    return { mail, rep, settings };
  }
  const batchLeads = (id, extra = '') => pool.query(
    `SELECT * FROM leads WHERE import_batch_id = $1 AND status = 'accepted' ${extra} ORDER BY id`, [id]);

  // Aperçu : rendu avec la PREMIÈRE piste acceptée du lot (vrai nom, vrai rep), lien factice —
  // émettre un vrai lien remplacerait celui que le client a peut-être déjà reçu.
  app.get('/api/leads/import/batches/:id/email-preview', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:import'))) return;
    try {
      await ensureSchema();
      const batch = (await pool.query(`SELECT * FROM lead_import_batches WHERE id = $1`, [Number(req.params.id)])).rows[0];
      if (!batch) return res.status(404).json({ error: 'not_found' });
      const lead = (await batchLeads(batch.id)).rows[0];
      if (!lead) return res.status(409).json({ error: 'not_accepted' });
      const lang = req.query.lang === 'fr' ? 'fr' : req.query.lang === 'en' ? 'en' : lead.language;
      const { mail, rep, settings } = await renderFor(batch, { ...lead, language: lang }, `${h().base()}/rdv?token=apercu`);
      const sender = h().senderFor(rep, settings);
      res.json({ subject: mail.subject, html: mail.html, from: sender.from || null, replyTo: sender.replyTo || null, sampleLead: lead.business_name });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/leads/import/batches/:id/email-test', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:import'))) return;
    try {
      await ensureSchema();
      const batch = (await pool.query(`SELECT * FROM lead_import_batches WHERE id = $1`, [Number(req.params.id)])).rows[0];
      if (!batch) return res.status(404).json({ error: 'not_found' });
      const lead = (await batchLeads(batch.id)).rows[0];
      if (!lead) return res.status(409).json({ error: 'not_accepted' });
      const to = req.user.email;
      const lang = req.body?.lang === 'fr' ? 'fr' : req.body?.lang === 'en' ? 'en' : lead.language;
      const { mail, rep, settings } = await renderFor(batch, { ...lead, language: lang }, `${h().base()}/rdv?token=apercu`);
      // Même expéditeur que le vrai envoi : le test doit montrer ce que le client verra arriver.
      const m = await h().sendMail(to, `[TEST] ${mail.subject}`, mail.html, h().senderFor(rep, settings));
      res.json({ sent: !!m.sent, to, error: m.sent ? null : m.reason });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/leads/import/batches/:id/send', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:import'))) return;
    const actor = actorOf(req);
    try {
      await ensureSchema();
      const batch = (await pool.query(`SELECT * FROM lead_import_batches WHERE id = $1`, [Number(req.params.id)])).rows[0];
      if (!batch) return res.status(404).json({ error: 'not_found' });
      const leads = (await batchLeads(batch.id, `AND merchant_notified_at IS NULL AND contact_email IS NOT NULL`)).rows;
      let sent = 0;
      const failed = [];
      for (const lead of leads) {
        let step;
        try {
          const bookingUrl = await h().issueLink(lead.id);
          const { mail, rep, settings } = await renderFor(batch, lead, bookingUrl);
          const sender = h().senderFor(rep, settings);
          const m = await h().sendMail(lead.contact_email, mail.subject, mail.html, sender);
          step = m.sent ? { ok: true, at: new Date().toISOString(), to: lead.contact_email, from: sender.from || null, by: actor }
                        : { ok: false, at: new Date().toISOString(), error: m.reason };
        } catch (e) { step = { ok: false, at: new Date().toISOString(), error: e.message.slice(0, 300) }; }
        await pool.query(
          `UPDATE leads SET automation = jsonb_set(COALESCE(automation, '{}'::jsonb), '{eventThanks}', $2::jsonb),
                  merchant_notified_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE merchant_notified_at END
            WHERE id = $1`, [lead.id, JSON.stringify(step), !!step.ok]);
        if (step.ok) sent++; else failed.push({ refCode: lead.ref_code, business: lead.business_name, error: step.error });
      }
      if (sent) await pool.query(`UPDATE lead_import_batches SET emailed_at = CURRENT_TIMESTAMP WHERE id = $1`, [batch.id]);
      if (sent || failed.length) logActivity('lead_import', batch.id, 'emailed',
        `Lot « ${batch.event_name} » : remerciement envoyé à ${sent} visiteurs${failed.length ? `, ${failed.length} en échec` : ''}`, actor);
      res.json({ sent, failed, batch: await loadBatch(batch.id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

// Le récapitulatif au représentant — interne, bilingue, enveloppe Sales Hub comme les autres avis.
function repSummaryEmail(mailShell, eventName, rep, list, base) {
  const n = list.length;
  const items = list.map((l) => `<li style="margin:0 0 8px"><strong>${esc(l.businessName)}</strong>`
    + `${l.firstName || l.lastName ? ` — ${esc([l.firstName, l.lastName].filter(Boolean).join(' '))}` : ''}`
    + `${l.email ? ` · ${esc(l.email)}` : ''}${l.phone ? ` · ${esc(l.phone)}` : ''}`
    + `${l.comments?.length ? `<br><span style="color:#64748b">${esc(l.comments.join(' / '))}</span>` : ''}`
    + ` <span style="color:#94a3b8">(${esc(l.refCode)})</span></li>`).join('');
  const intro = `<p>${n} piste${n > 1 ? 's' : ''} du salon <strong>${esc(eventName)}</strong> vous ${n > 1 ? 'sont' : 'est'} attribuée${n > 1 ? 's' : ''} et ${n > 1 ? 'sont' : 'est'} maintenant dans Zoho à votre nom. `
    + `Aucun rappel n'a été planifié : chaque visiteur recevra un courriel de remerciement avec un lien pour réserver une rencontre avec vous, et vous serez avisé quand il le fera.</p>`
    + `<p style="color:#64748b">${n} lead${n > 1 ? 's' : ''} from <strong>${esc(eventName)}</strong> ${n > 1 ? 'are' : 'is'} now assigned to you in Zoho. `
    + `No callback was scheduled: each visitor gets a thank-you email with a link to book a meeting with you, and you'll be notified when they do.</p>`
    + `<ul style="padding-left:18px;margin:14px 0 0">${items}</ul>`;
  return [`Salon ${eventName} : ${n} piste${n > 1 ? 's' : ''} pour vous / ${n} lead${n > 1 ? 's' : ''} for you`,
          mailShell(`Salon ${esc(eventName)} — ${n} piste${n > 1 ? 's' : ''}`, intro, 'Voir mes pistes / View my leads', `${base}/leads`, undefined, 'saleshub')];
}

module.exports = { registerLeadImportRoutes, repSummaryEmail };
