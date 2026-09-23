// ============================================================================
// Modélisateur de revenus — couche HTTP.
//
// Outil de vente interne : le rep modélise le P&L sur 3 ans de l'intégration d'une chaîne
// (SaaS, crédit, Interac, terminaux, matériel, installation, commissions). Les CALCULS se
// font dans le navigateur, à chaque frappe — c'est une simulation, rien ici n'est facturé ni
// payé, et rien ne part chez un client. Le serveur ne fait que deux choses :
//   1. servir les valeurs par défaut (ce sont les coûts de Cluster, voir defaults.js) ;
//   2. garder les scénarios nommés (« Chez Cora — Base »).
//
// Monté par UNE ligne dans server.js, comme services/icplus : ce fichier-là est énorme et
// plusieurs sessions l'éditent à la fois.
//
// 🔑 BIBLIOTHÈQUE D'ÉQUIPE (depuis le 2026-09-23, à la demande de David). Tout détenteur de
// `revmodel:use` voit TOUS les scénarios, avec leur auteur. Seul l'auteur (ou un admin) peut
// les écraser ou les supprimer : « Enregistrer » sous le même nom chez un autre usager crée SA
// copie, sans toucher à l'original. Le lien partagé ne porte que l'identifiant (UUID) — le
// volume d'un marchand ne passe jamais dans une URL.
// ============================================================================

const crypto = require('crypto');
const { DEFAULTS, SAAS_TIERS, MAX_NAME, validateInputs, validateTiers, upgradeInputs } = require('./defaults');

const PERM_USE = 'revmodel:use';
// Changer les paliers les change pour TOUS les usagers du modélisateur : permission distincte.
const PERM_SETTINGS = 'revmodel:settings';
const TIERS_KEY = 'revenue_model_saas_tiers';
// Valeurs de départ d'un nouveau modèle, modifiables depuis la page. Le prix SaaS n'y est PAS :
// il suit toujours le palier du milieu, sinon deux réglages pourraient se contredire.
const DEFAULTS_KEY = 'revenue_model_defaults';
const MAX_SCENARIOS_PER_USER = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS revenue_model_scenarios (
      id          UUID PRIMARY KEY,
      owner_email TEXT NOT NULL,
      name        TEXT NOT NULL,
      inputs      JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Un même nom chez un même usager = on écrase (c'est ce qu'attend « Enregistrer »).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS revenue_model_scenarios_owner_name
      ON revenue_model_scenarios (LOWER(owner_email), name)`);
}

// Nom de l'auteur, résolu comme ailleurs dans l'app (« voir en tant que ») : compte Zoho, puis
// compte externe, puis fiche vendeur. NULLIF : un nom vide ne doit pas masquer le suivant.
const OWNER_NAME_SQL = `COALESCE(
  (SELECT NULLIF(TRIM(display_name), '') FROM user_tokens  WHERE LOWER(email) = LOWER(s.owner_email) LIMIT 1),
  (SELECT NULLIF(TRIM(display_name), '') FROM local_users  WHERE LOWER(email) = LOWER(s.owner_email) LIMIT 1),
  (SELECT NULLIF(TRIM(name), '')         FROM salespeople  WHERE LOWER(email) = LOWER(s.owner_email) LIMIT 1)
) AS owner_name`;

const shape = (r, email) => ({
  id: r.id,
  name: r.name,
  inputs: upgradeInputs(r.inputs),
  owner: r.owner_email,
  // Nom affiché de l'auteur ; le courriel en dernier recours (compte sans nom connu).
  ownerName: r.owner_name || r.owner_email,
  mine: !!email && r.owner_email.toLowerCase() === email.toLowerCase(),
  updatedAt: r.updated_at,
});

// Paliers en vigueur : app_settings s'il y a une valeur valide, sinon ceux du code. Une valeur
// stockée invalide (édition manuelle en base) retombe sur le code plutôt que de casser la page.
async function readTiers(pool) {
  try {
    const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [TIERS_KEY]);
    if (!r.rows[0]) return [...SAAS_TIERS];
    let v = r.rows[0].value;
    if (typeof v === 'string') v = JSON.parse(v);
    return validateTiers(v) || [...SAAS_TIERS];
  } catch { return [...SAAS_TIERS]; }
}

// Valeurs par défaut en vigueur = celles du code, recouvertes par celles enregistrées depuis la
// page. Une valeur stockée devenue invalide fait retomber sur le code, jamais casser la page.
async function readDefaults(pool) {
  try {
    const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [DEFAULTS_KEY]);
    if (!r.rows[0]) return { ...DEFAULTS };
    let v = r.rows[0].value;
    if (typeof v === 'string') v = JSON.parse(v);
    const ok = validateInputs({ ...DEFAULTS, ...v });
    return ok.ok ? ok.inputs : { ...DEFAULTS };
  } catch { return { ...DEFAULTS }; }
}

function registerRevenueModelRoutes(app, deps) {
  const { authenticateToken, requirePerm, hasPerm, pool, logActivity } = deps;

  // Décidé par le serveur, jamais lu du jeton côté navigateur (voir impersonation-security).
  async function canEditSettings(req) {
    if (req.user && req.user.isAdmin === true) return true;
    try { return await hasPerm(req, PERM_SETTINGS); } catch { return false; }
  }

  let ready = null;
  const schema = () => (ready = ready || ensureSchema(pool).catch((e) => { ready = null; throw e; }));
  if (pool) schema().catch((e) => console.error('revenue_model schema:', e.message));

  app.get('/api/revenue-model/defaults', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_USE))) return;
    const [saasTiers, base] = await Promise.all([readTiers(pool), readDefaults(pool)]);
    // Un nouveau modèle démarre au palier du MILIEU : si les paliers changent, le prix par défaut
    // suit, sinon il ne correspondrait plus à aucune pastille. Les scénarios gardent le leur.
    res.json({
      defaults: { ...base, saasPerLoc: saasTiers[1] },
      saasTiers,
      canEditSettings: await canEditSettings(req),
    });
  });

  // Enregistre les saisies courantes comme point de départ de TOUT nouveau modèle.
  app.put('/api/revenue-model/defaults', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SETTINGS))) return;
    const v = validateInputs(req.body && req.body.inputs);
    if (!v.ok) return res.status(400).json({ error: 'bad_input', field: v.field });
    const { saasPerLoc, ...next } = v.inputs;
    try {
      const before = await readDefaults(pool);
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [DEFAULTS_KEY, JSON.stringify(next)]);
      // Trace champ par champ, avant → après : ce sont les coûts de Cluster.
      const changed = Object.keys(next).filter((k) => before[k] !== next[k])
        .map((k) => ({ field: k, before: before[k], after: next[k] }));
      await logActivity('revenue_model', 'defaults', 'defaults_updated',
        changed.length
          ? `Valeurs par défaut : ${changed.map((c) => `${c.field} ${c.before} → ${c.after}`).join(', ')}`
          : 'Valeurs par défaut réenregistrées sans changement',
        req.user.email, { metadata: { changed } });
      const saasTiers = await readTiers(pool);
      res.json({ defaults: { ...next, saasPerLoc: saasTiers[1] }, changed: changed.length });
    } catch (e) {
      console.error('revenue-model defaults:', e.message);
      res.status(500).json({ error: 'save_failed' });
    }
  });

  app.put('/api/revenue-model/saas-tiers', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_SETTINGS))) return;
    const tiers = validateTiers(req.body && req.body.tiers);
    if (!tiers) return res.status(400).json({ error: 'bad_tiers' });
    try {
      const before = await readTiers(pool);
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [TIERS_KEY, JSON.stringify(tiers)]);
      await logActivity('revenue_model', 'saas_tiers', 'saas_tiers_updated',
        `Paliers SaaS : ${before.join(' / ')} → ${tiers.join(' / ')} $`, req.user.email,
        { metadata: { before, after: tiers } });
      res.json({ saasTiers: tiers });
    } catch (e) {
      console.error('revenue-model tiers:', e.message);
      res.status(500).json({ error: 'save_failed' });
    }
  });

  app.get('/api/revenue-model/scenarios', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_USE))) return;
    try {
      await schema();
      const { rows } = await pool.query(
        // Les siens d'abord, puis ceux de l'équipe ; les plus récents en tête dans chaque groupe.
        `SELECT s.*, ${OWNER_NAME_SQL} FROM revenue_model_scenarios s
         ORDER BY (LOWER(s.owner_email) = LOWER($1)) DESC, s.updated_at DESC`, [req.user.email || '']);
      res.json({ scenarios: rows.map((r) => shape(r, req.user.email)) });
    } catch (e) {
      console.error('revenue-model list:', e.message);
      res.status(500).json({ error: 'load_failed' });
    }
  });

  // Ouverture par lien : tout détenteur de la permission, pas seulement l'auteur.
  app.get('/api/revenue-model/scenarios/:id', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_USE))) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    try {
      await schema();
      const { rows } = await pool.query(
        `SELECT s.*, ${OWNER_NAME_SQL} FROM revenue_model_scenarios s WHERE s.id = $1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'not_found' });
      res.json({ scenario: shape(rows[0], req.user.email) });
    } catch (e) {
      console.error('revenue-model get:', e.message);
      res.status(500).json({ error: 'load_failed' });
    }
  });

  // Enregistrer sous un nom : crée, ou écrase le scénario du même nom chez le même usager.
  app.post('/api/revenue-model/scenarios', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_USE))) return;
    const email = req.user.email;
    if (!email) return res.status(403).json({ error: 'no_email' });
    const name = String((req.body && req.body.name) || '').trim();
    if (!name || name.length > MAX_NAME) return res.status(400).json({ error: 'bad_name' });
    const v = validateInputs(req.body && req.body.inputs);
    if (!v.ok) return res.status(400).json({ error: 'bad_input', field: v.field });
    try {
      await schema();
      const existing = await pool.query(
        'SELECT id FROM revenue_model_scenarios WHERE LOWER(owner_email) = LOWER($1) AND name = $2',
        [email, name]);
      if (!existing.rows.length) {
        const { rows: [{ n }] } = await pool.query(
          'SELECT COUNT(*)::int AS n FROM revenue_model_scenarios WHERE LOWER(owner_email) = LOWER($1)', [email]);
        if (n >= MAX_SCENARIOS_PER_USER) return res.status(400).json({ error: 'too_many' });
      }
      const { rows } = await pool.query(
        `INSERT INTO revenue_model_scenarios (id, owner_email, name, inputs)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (LOWER(owner_email), name)
         DO UPDATE SET inputs = EXCLUDED.inputs, updated_at = NOW()
         RETURNING *`,
        [crypto.randomUUID(), email, name, JSON.stringify(v.inputs)]);
      const row = rows[0];
      await logActivity('revenue_model', row.id, existing.rows.length ? 'scenario_updated' : 'scenario_created',
        `Scénario « ${name} » (${v.inputs.merchantName})`, email);
      res.json({ scenario: shape(row, email) });
    } catch (e) {
      console.error('revenue-model save:', e.message);
      res.status(500).json({ error: 'save_failed' });
    }
  });

  app.delete('/api/revenue-model/scenarios/:id', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_USE))) return;
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    try {
      await schema();
      const { rows } = await pool.query('SELECT * FROM revenue_model_scenarios WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'not_found' });
      const row = rows[0];
      const mine = (req.user.email || '').toLowerCase() === row.owner_email.toLowerCase();
      if (!mine && req.user.isAdmin !== true) return res.status(403).json({ error: 'not_owner' });
      await pool.query('DELETE FROM revenue_model_scenarios WHERE id = $1', [row.id]);
      await logActivity('revenue_model', row.id, 'scenario_deleted', `Scénario « ${row.name} » supprimé`, req.user.email);
      res.json({ ok: true });
    } catch (e) {
      console.error('revenue-model delete:', e.message);
      res.status(500).json({ error: 'delete_failed' });
    }
  });
}

module.exports = { registerRevenueModelRoutes, PERM_USE, PERM_SETTINGS };
