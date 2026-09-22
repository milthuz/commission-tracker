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
// 🔑 PARTAGE PAR LIEN. La liste ne montre que les scénarios de l'usager. Un scénario s'ouvre
// quand même par son identifiant (UUID aléatoire, non devinable) pour qui détient la
// permission : c'est ce qu'envoie le bouton « Copier le lien ». Le volume d'un marchand ne
// passe donc jamais dans une URL — seul l'identifiant y est. Seul l'auteur (ou un admin)
// peut modifier ou supprimer.
// ============================================================================

const crypto = require('crypto');
const { DEFAULTS, SAAS_TIERS, MAX_NAME, validateInputs } = require('./defaults');

const PERM_USE = 'revmodel:use';
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

const shape = (r, email) => ({
  id: r.id,
  name: r.name,
  inputs: r.inputs,
  owner: r.owner_email,
  mine: !!email && r.owner_email.toLowerCase() === email.toLowerCase(),
  updatedAt: r.updated_at,
});

function registerRevenueModelRoutes(app, deps) {
  const { authenticateToken, requirePerm, pool, logActivity } = deps;

  let ready = null;
  const schema = () => (ready = ready || ensureSchema(pool).catch((e) => { ready = null; throw e; }));
  if (pool) schema().catch((e) => console.error('revenue_model schema:', e.message));

  app.get('/api/revenue-model/defaults', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_USE))) return;
    res.json({ defaults: DEFAULTS, saasTiers: SAAS_TIERS });
  });

  app.get('/api/revenue-model/scenarios', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_USE))) return;
    try {
      await schema();
      const { rows } = await pool.query(
        `SELECT * FROM revenue_model_scenarios WHERE LOWER(owner_email) = LOWER($1)
         ORDER BY updated_at DESC`, [req.user.email || '']);
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
      const { rows } = await pool.query('SELECT * FROM revenue_model_scenarios WHERE id = $1', [req.params.id]);
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

module.exports = { registerRevenueModelRoutes, PERM_USE };
