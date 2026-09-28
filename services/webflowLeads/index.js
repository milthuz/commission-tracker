// ============================================================================
// Pistes du site Webflow — le webhook NATIF de Webflow (form_submission) entre directement dans
// la file des pistes, sans relais.
//
// Monté par UNE ligne dans server.js (comme services/leadBooking).
//
// Pourquoi un endpoint à part plutôt que /api/webhooks/website-lead : Webflow n'a pas de serveur
// où poser notre en-tête X-Cluster-Webhook-Secret, et il envoie son propre format
// ({ triggerType, payload: { name, data, schema, id, … } }).
//
// 🔑 LA CONNEXION se fait depuis Sales Hub (Admin → Pistes → Automatisations → Webflow) : David
// colle UNE fois un jeton API du site ; Sales Hub crée lui-même le webhook dans Webflow et garde
// ce que Webflow renvoie. Personne ne se passe de secret (demande du développeur du site).
//
// 🔑 DEUX PROTECTIONS, cumulées :
//   1. une CLÉ ALÉATOIRE dans l'adresse du webhook (/api/webhooks/webflow-form/<clé>), connue de
//      Webflow seul — elle tient même si Webflow ne renvoie pas de secret de signature ;
//   2. la SIGNATURE Webflow (x-webflow-signature = HMAC-SHA256 hex de `horodatage:corps brut`,
//      fenêtre de 5 minutes) dès que Webflow a renvoyé un `secretKey` à la création. ⚠️ Webflow ne
//      signe QUE les webhooks créés par l'API — jamais ceux du tableau de bord du site.
//
// 🔑 DOUBLONS : Webflow réessaie jusqu'à 3 fois tout ce qui n'a pas reçu un 200. La piste garde
// l'identifiant de la soumission (`leads.external_ref`, index unique) : un réessai ne crée rien.
//
// 🔑 LES CHAMPS : chaque nom de champ Webflow est rapproché d'un champ de piste (heuristique FR/EN,
// corrigeable écran par écran). Un champ que rien ne reconnaît n'est JAMAIS perdu : il est ajouté
// au message de la piste (« Champ : valeur »).
// ============================================================================

const crypto = require('crypto');
const axios = require('axios');

const API = 'https://api.webflow.com/v2';
const SETTINGS_KEY = 'webflow_integration';
const FORMS_KEY = 'webflow_forms';
const MAX_SKEW_MS = 5 * 60 * 1000;

// Les champs de piste qu'un champ Webflow peut alimenter (clé = nom compris par
// normalizeLeadInput dans server.js).
const TARGETS = [
  'businessName', 'contactFirstName', 'contactLastName', 'contactName', 'contactEmail', 'contactPhone',
  'contactTitle', 'language', 'province', 'city', 'postalCode', 'website', 'businessType',
  'locationsCount', 'currentPos', 'timeline', 'interest', 'notes',
];

// « Nom de l'entreprise » → « nomdelentreprise » : sans accents, sans ponctuation, minuscules.
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Heuristique : premier motif qui correspond au nom normalisé. L'ORDRE compte (« nomdelentreprise »
// doit tomber sur l'entreprise avant « nom » ; « prenom » avant « nom »).
const GUESSES = [
  [/^(lang|langue|language|locale)$/, 'language'],
  [/(courriel|email|mail)/, 'contactEmail'],
  [/(telephone|phone|^tel$|^tel\d|cellulaire|mobile|cell)/, 'contactPhone'],
  [/(typede(commerce|entreprise)|businesstype|industr|secteur|categorie)/, 'businessType'],
  [/(entreprise|company|compagnie|commerce|business(name)?$|restaurant|etablissement|organisation|organization|societe)/, 'businessName'],
  [/(prenom|firstname|givenname)/, 'contactFirstName'],
  [/(nomdefamille|lastname|surname|familyname)/, 'contactLastName'],
  [/^(nom|name|fullname|nomcomplet|votrenom|yourname|contact|contactname)$/, 'contactName'],
  [/(titre|poste|jobtitle|^title$|role)/, 'contactTitle'],
  [/(codepostal|postalcode|postal|zip)/, 'postalCode'],
  [/(province|state|region)/, 'province'],
  [/(ville|city)/, 'city'],
  [/(siteweb|website|siteinternet|url)/, 'website'],
  [/(succursale|locations|nombredemagasins|stores|emplacements)/, 'locationsCount'],
  [/(systemeactuel|currentpos|currentsystem|posactuel|systeme)/, 'currentPos'],
  [/(echeance|timeline|delai|quand|when)/, 'timeline'],
  [/(interet|interest|produit|product|service)/, 'interest'],
  [/(message|commentaire|comment|details|question|notes|besoin|description)/, 'notes'],
];
function guessTarget(fieldName) {
  const n = norm(fieldName);
  if (!n) return null;
  for (const [re, t] of GUESSES) if (re.test(n)) return t;
  return null;
}

// Transforme `data` (clés = noms de champs Webflow) en objet compris par normalizeLeadInput.
// fieldMap : { "<nom exact du champ>": "<cible>" | "ignore" | "notes" } — prime sur l'heuristique.
function mapSubmission(data, fieldMap = {}) {
  const out = {};
  const extras = [];
  for (const [field, raw] of Object.entries(data || {})) {
    const value = Array.isArray(raw) ? raw.join(', ') : raw == null ? '' : String(raw).trim();
    if (!value) continue;
    const explicit = fieldMap[field];
    const target = explicit || guessTarget(field);
    if (target === 'ignore') continue;
    if (!target || target === 'extra' || !TARGETS.includes(target)) { extras.push(`${field} : ${value}`); continue; }
    if (target === 'notes') { out.notes = out.notes ? `${out.notes}\n${value}` : value; continue; }
    // Deux champs sur la même cible (ex. deux cases « intérêt ») : on les joint plutôt que d'en perdre un.
    out[target] = out[target] ? `${out[target]}, ${value}` : value;
  }
  if (extras.length) out.notes = [out.notes, extras.join('\n')].filter(Boolean).join('\n\n');
  return out;
}

// Vérification de la signature Webflow. `rawBody` = le corps EXACT reçu (Buffer).
function verifySignature({ secret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!secret) return { ok: true, skipped: true };
  if (!timestamp || !signature || !rawBody) return { ok: false, reason: 'missing_signature' };
  let ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };
  if (ts < 1e12) ts *= 1000; // secondes → millisecondes, par prudence
  if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, reason: 'stale' };
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}:${rawBody.toString('utf8')}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature).trim().toLowerCase(), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

function registerWebflowLeadRoutes(app, deps) {
  const { authenticateToken, requirePerm, pool, logActivity } = deps;
  const h = () => deps.late(); // createLeadRow, normalizeLeadInput — définis plus bas dans server.js
  const backendBase = () => process.env.BACKEND_URL || 'https://commission-tracker-production-b7f9.up.railway.app';

  let schemaReady = null;
  function ensureSchema() {
    if (!schemaReady) {
      schemaReady = (async () => {
        await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_ref VARCHAR(160)`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_external_ref ON leads(external_ref) WHERE external_ref IS NOT NULL`);
      })().catch((e) => { schemaReady = null; throw e; });
    }
    return schemaReady;
  }
  setTimeout(() => ensureSchema().catch((e) => console.warn('[webflow] schéma pas encore prêt :', e.message)), 20000);

  const getSetting = async (key) => {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
    return r.rows[0]?.value || null;
  };
  const setSetting = (key, value) => pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, JSON.stringify(value)]);

  const wf = (token) => ({
    get: (p) => axios.get(`${API}${p}`, { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }, validateStatus: () => true, timeout: 20000 }),
    post: (p, body) => axios.post(`${API}${p}`, body, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' }, validateStatus: () => true, timeout: 20000 }),
    del: (p) => axios.delete(`${API}${p}`, { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true, timeout: 20000 }),
  });
  const wfError = (r) => {
    const msg = r.data?.message || r.data?.msg || r.data?.err || `HTTP ${r.status}`;
    if (r.status === 401) return { code: 'invalid_token', message: String(msg) };
    if (r.status === 403) return { code: 'missing_scope', message: String(msg) };
    return { code: 'webflow_error', message: String(msg).slice(0, 300) };
  };

  // ── Le webhook ────────────────────────────────────────────────────────────
  app.post('/api/webhooks/webflow-form/:key', async (req, res) => {
    try {
      const cfg = await getSetting(SETTINGS_KEY);
      const key = String(req.params.key || '');
      const a = Buffer.from(key), b = Buffer.from(String(cfg?.urlKey || ''));
      if (!cfg?.urlKey || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        console.warn('🚫 [webflow] clé d\'adresse invalide');
        return res.status(401).json({ error: 'invalid key' });
      }
      const sig = verifySignature({
        secret: cfg.secretKey, timestamp: req.headers['x-webflow-timestamp'],
        signature: req.headers['x-webflow-signature'], rawBody: req.rawBody,
      });
      if (!sig.ok) {
        console.warn(`🚫 [webflow] signature refusée : ${sig.reason}`);
        return res.status(401).json({ error: sig.reason });
      }

      const body = req.body || {};
      const p = body.payload || {};
      if (body.triggerType && body.triggerType !== 'form_submission') return res.json({ ok: true, ignored: 'trigger' });
      const formName = String(p.name || 'Formulaire').slice(0, 120);
      const submissionId = p.id ? `webflow:${p.id}` : null;

      // Mémoriser les champs vus pour l'écran de correspondance, même si la piste est ignorée.
      try {
        const forms = (await getSetting(FORMS_KEY)) || {};
        const fields = Array.isArray(p.schema) && p.schema.length
          ? p.schema.map((s) => s.fieldName).filter(Boolean)
          : Object.keys(p.data || {});
        const prev = forms[formName] || { count: 0, fields: [] };
        forms[formName] = {
          fields: [...new Set([...(prev.fields || []), ...fields])].slice(0, 60),
          count: (prev.count || 0) + 1, lastAt: new Date().toISOString(), formId: p.formId || prev.formId || null,
        };
        await setSetting(FORMS_KEY, forms);
      } catch (e) { console.warn('[webflow] champs non mémorisés :', e.message); }

      await ensureSchema();
      if (submissionId) {
        const dup = (await pool.query(`SELECT ref_code FROM leads WHERE external_ref = $1`, [submissionId])).rows[0];
        if (dup) return res.json({ ok: true, duplicate: true, ref: dup.ref_code });
      }

      const mapped = mapSubmission(p.data, cfg.fieldMap || {});
      if (!mapped.language) mapped.language = cfg.defaultLanguage || 'fr';
      mapped.source = 'website';
      mapped.sourceDetail = `Webflow — ${formName}`;
      const input = h().normalizeLeadInput(mapped, { source: 'website' });
      if (!input.businessName && !input.email && !input.phone) {
        // 200 quand même : Webflow réessaierait sans fin une soumission qui ne changera pas.
        logActivity('lead', 0, 'webflow_ignored', `Soumission Webflow « ${formName} » ignorée : ni entreprise, ni courriel, ni téléphone`, 'webflow');
        return res.json({ ok: true, ignored: 'no_identity' });
      }
      if (!input.businessName) input.businessName = [input.firstName, input.lastName].filter(Boolean).join(' ') || input.email || input.phone;

      const out = await h().createLeadRow(input, { raw: body });
      if (submissionId) {
        await pool.query(`UPDATE leads SET external_ref = $2 WHERE id = $1`, [out.id, submissionId])
          .catch((e) => console.warn('[webflow] external_ref non enregistré :', e.message));
      }
      console.log(`🎯 [leads] ${out.refCode} — ${input.businessName} (Webflow « ${formName} »)`);
      res.json({ ok: true, ref: out.refCode });
    } catch (e) {
      console.error('[webflow] webhook :', e.message);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ── Administration (permission leads:manage_rules, comme le reste des réglages des pistes) ──
  const publicState = async () => {
    const cfg = (await getSetting(SETTINGS_KEY)) || {};
    const forms = (await getSetting(FORMS_KEY)) || {};
    return {
      connected: !!cfg.webhookId,
      siteName: cfg.siteName || null, siteId: cfg.siteId || null,
      connectedAt: cfg.connectedAt || null, connectedBy: cfg.connectedBy || null,
      signed: !!cfg.secretKey,
      defaultLanguage: cfg.defaultLanguage || 'fr',
      fieldMap: cfg.fieldMap || {},
      targets: TARGETS,
      forms: Object.entries(forms).map(([name, f]) => ({
        name, count: f.count || 0, lastAt: f.lastAt || null,
        fields: (f.fields || []).map((field) => ({ field, guess: guessTarget(field) })),
      })).sort((x, y) => String(y.lastAt).localeCompare(String(x.lastAt))),
    };
  };

  app.get('/api/admin/webflow', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:manage_rules'))) return;
    try { res.json(await publicState()); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Connecter : le jeton sert à trouver le site et à (re)créer le webhook. Il est gardé pour pouvoir
  // déconnecter proprement plus tard ; il n'est JAMAIS renvoyé au navigateur.
  app.post('/api/admin/webflow/connect', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:manage_rules'))) return;
    const token = String(req.body?.token || '').trim();
    const wantedSite = String(req.body?.siteId || '').trim();
    const actor = req.user.realAdminEmail || req.user.email || 'unknown';
    if (token.length < 20) return res.status(400).json({ error: 'invalid_token' });
    try {
      const api = wf(token);
      const s = await api.get('/sites');
      if (s.status !== 200) return res.status(400).json({ error: wfError(s).code, detail: wfError(s).message });
      const sites = (s.data?.sites || []).map((x) => ({ id: x.id, name: x.displayName || x.shortName || x.id }));
      if (!sites.length) return res.status(400).json({ error: 'no_site' });
      const site = wantedSite ? sites.find((x) => x.id === wantedSite) : sites.length === 1 ? sites[0] : null;
      if (!site) return res.status(409).json({ error: 'pick_site', sites });

      // Reconnexion : on retire d'abord les webhooks que Sales Hub avait déjà posés sur ce site.
      const prefix = `${backendBase()}/api/webhooks/webflow-form/`;
      const list = await api.get(`/sites/${site.id}/webhooks`);
      if (list.status === 200) {
        for (const w of (list.data?.webhooks || [])) {
          if (String(w.url || '').startsWith(prefix)) await api.del(`/webhooks/${w.id}`);
        }
      }

      const urlKey = crypto.randomBytes(24).toString('base64url');
      const c = await api.post(`/sites/${site.id}/webhooks`, { triggerType: 'form_submission', url: `${prefix}${urlKey}` });
      if (c.status < 200 || c.status >= 300) return res.status(400).json({ error: wfError(c).code, detail: wfError(c).message });

      const prev = (await getSetting(SETTINGS_KEY)) || {};
      await setSetting(SETTINGS_KEY, {
        ...prev, token, siteId: site.id, siteName: site.name, webhookId: c.data?.id || null,
        secretKey: c.data?.secretKey || c.data?.secret_key || null, urlKey,
        connectedAt: new Date().toISOString(), connectedBy: actor,
      });
      logActivity('lead_settings', 0, 'webflow_connected',
        `Webflow connecté (${site.name}) par ${actor}${c.data?.secretKey ? ' — signature active' : ' — sans secret de signature (clé d\'adresse seule)'}`, actor);
      res.json(await publicState());
    } catch (e) {
      console.error('[webflow] connexion :', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/webflow/disconnect', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:manage_rules'))) return;
    const actor = req.user.realAdminEmail || req.user.email || 'unknown';
    try {
      const cfg = (await getSetting(SETTINGS_KEY)) || {};
      let warning = null;
      if (cfg.token && cfg.webhookId) {
        const d = await wf(cfg.token).del(`/webhooks/${cfg.webhookId}`);
        if (!(d.status >= 200 && d.status < 300) && d.status !== 404) warning = wfError(d).message;
      }
      // La clé d'adresse est effacée : même si le webhook restait chez Webflow, il serait refusé.
      await setSetting(SETTINGS_KEY, { fieldMap: cfg.fieldMap || {}, defaultLanguage: cfg.defaultLanguage || 'fr' });
      logActivity('lead_settings', 0, 'webflow_disconnected', `Webflow déconnecté par ${actor}${warning ? ` (Webflow : ${warning})` : ''}`, actor);
      res.json({ ...(await publicState()), warning });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/webflow/mapping', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:manage_rules'))) return;
    try {
      const allowed = new Set([...TARGETS, 'ignore', 'extra']);
      const fieldMap = {};
      for (const [k, v] of Object.entries(req.body?.fieldMap || {})) {
        if (typeof k === 'string' && k.length <= 120 && allowed.has(v)) fieldMap[k] = v;
      }
      const defaultLanguage = req.body?.defaultLanguage === 'en' ? 'en' : 'fr';
      const cfg = (await getSetting(SETTINGS_KEY)) || {};
      await setSetting(SETTINGS_KEY, { ...cfg, fieldMap, defaultLanguage });
      res.json(await publicState());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { registerWebflowLeadRoutes, mapSubmission, guessTarget, verifySignature, TARGETS };
