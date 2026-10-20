// Campagne golf — liste de clubs à appeler pour proposer une alternative à Lightspeed
// (ex-GGGolf), avec questionnaire d'appel, journal d'appels et suivi des rendez-vous.
// Tables créées à la demande (même patron que services/nda). Données de départ : seed.json.
const crypto = require('crypto');
const SEED = require('./seed.json');

const PERM_USE = 'golfcampaign:use';
const PERM_MANAGE = 'golfcampaign:manage';

const STATUSES = ['to_call', 'no_answer', 'callback', 'meeting', 'interested', 'not_interested', 'wrong_number'];
const SETTINGS_KEY = 'golf_campaign_questionnaire';
const SCRIPT_KEY = 'golf_campaign_script';

// Accroche d'ouverture (≈30 s). {{club}} et {{contact}} sont remplacés à l'affichage. Modifiable (manage).
const DEFAULT_SCRIPT = {
  fr: 'Bonjour {{contact}}, ici [votre nom] de Cluster. Je vous appelle parce que plusieurs clubs de golf du Québec qui utilisent GGGolf se font imposer une migration vers Lightspeed. Nous avons développé une plateforme de gestion de golf 100 % web, moderne et dotée d’intelligence artificielle, pour {{club}} et ses membres. Avez-vous 2 minutes pour que je vous pose quelques questions sur votre situation, et peut-être planifier une courte démo ?',
  en: 'Hi {{contact}}, this is [your name] from Cluster. I’m calling because many Quebec golf clubs on GGGolf are being moved to Lightspeed. We built a modern, 100% web-based golf management platform with built-in AI for {{club}} and its members. Do you have 2 minutes for a few questions about your situation, and maybe a short demo?',
};

// Questionnaire par défaut ; modifiable depuis la page (perm golfcampaign:manage).
// type : choice | text | yesno. Les libellés sont bilingues {en, fr}.
const DEFAULT_QUESTIONNAIRE = [
  { id: 'platform', type: 'choice', label: { en: 'Which platform do you use today?', fr: 'Quelle plateforme utilisez-vous aujourd’hui ?' },
    options: ['GGGolf', 'Lightspeed Golf', 'Foretees', 'Club Prophet', 'Other', 'None'] },
  { id: 'notified', type: 'choice', label: { en: 'Have you been told your club must move to Lightspeed?', fr: 'Avez-vous été avisé que votre club doit migrer vers Lightspeed ?' },
    options: ['Yes', 'No', 'Not sure'] },
  { id: 'migration_date', type: 'text', label: { en: 'Migration date or deadline', fr: 'Date ou échéance de la migration' } },
  { id: 'contract_end', type: 'text', label: { en: 'Current contract end date', fr: 'Fin du contrat actuel' } },
  { id: 'satisfaction', type: 'choice', label: { en: 'How satisfied are you with the transition so far?', fr: 'Quel est votre niveau de satisfaction face à la transition ?' },
    options: ['Very satisfied', 'Satisfied', 'Neutral', 'Unsatisfied', 'Very unsatisfied'] },
  { id: 'modern', type: 'choice', label: { en: 'Does your software feel modern: web/cloud on any device, member app, online booking?', fr: 'Votre logiciel semble-t-il moderne : web/infonuagique sur tout appareil, application pour les membres, réservation en ligne ?' },
    options: ['Yes', 'Partly', 'No'] },
  { id: 'pain', type: 'text', label: { en: 'Biggest frustration with your current software', fr: 'Plus grande frustration avec votre logiciel actuel' } },
  { id: 'features', type: 'text', label: { en: 'Features you rely on most (tee times, tournaments, handicaps, memberships, F&B…)', fr: 'Fonctions dont vous dépendez le plus (réservations, tournois, handicaps, adhésions, restauration…)' } },
  { id: 'ai_interest', type: 'choice', label: { en: 'Would AI features interest you (smart tee sheet, automated member messages, assistant for staff)?', fr: 'Des fonctions d’IA vous intéresseraient-elles (feuille de départs intelligente, messages automatisés aux membres, assistant pour le personnel) ?' },
    options: ['Very interested', 'Curious', 'Not now'] },
  { id: 'pos', type: 'text', label: { en: 'Which POS / restaurant system do you use?', fr: 'Quel système de caisse / restauration utilisez-vous ?' } },
  { id: 'decider', type: 'text', label: { en: 'Who makes the software decision (name, role)?', fr: 'Qui décide pour le logiciel (nom, rôle) ?' } },
  { id: 'open', type: 'choice', label: { en: 'Open to a demo of a modern, web-based alternative to Lightspeed?', fr: 'Ouvert à une démo d’une alternative web et moderne à Lightspeed ?' },
    options: ['Yes', 'Maybe', 'No'] },
];

async function ensureSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS golf_clubs (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    contact_name TEXT, email TEXT, phone TEXT, address TEXT,
    source TEXT,
    gg_directory_name TEXT,
    is_cluster_client BOOLEAN NOT NULL DEFAULT FALSE,
    zoho_client_name TEXT, zoho_status TEXT, mrr NUMERIC,
    status TEXT NOT NULL DEFAULT 'to_call',
    assigned_to TEXT,
    callback_at TIMESTAMPTZ,
    meeting_at TIMESTAMPTZ,
    answers JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes TEXT,
    last_call_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS golf_clubs_name_uq ON golf_clubs (LOWER(name))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS golf_call_log (
    id UUID PRIMARY KEY,
    club_id UUID NOT NULL REFERENCES golf_clubs(id) ON DELETE CASCADE,
    by_email TEXT,
    outcome TEXT NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS golf_call_log_club_idx ON golf_call_log (club_id, created_at DESC)`);
}

// Insère les clubs de départ absents (jamais d'écrasement : le travail des reps est préservé).
async function seedClubs(pool) {
  let added = 0;
  for (const c of SEED) {
    const r = await pool.query(
      `INSERT INTO golf_clubs (id, name, contact_name, email, phone, address, source, gg_directory_name,
                               is_cluster_client, zoho_client_name, zoho_status, mrr)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (LOWER(name)) DO NOTHING`,
      [crypto.randomUUID(), c.name, c.contact_name, c.email, c.phone, c.address, c.source,
        c.gg_directory_name, !!c.is_cluster_client, c.zoho_client_name, c.zoho_status, c.mrr]);
    added += r.rowCount;
  }
  return added;
}

const text = (v, max = 2000) => (v == null ? null : String(v).trim().slice(0, max) || null);
const date = (v) => {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

function registerGolfCampaignRoutes(app, { authenticateToken, requirePerm, hasPerm, pool }) {
  let ready = null;
  const schema = () => (ready = ready || (async () => {
    await ensureSchema(pool);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM golf_clubs');
    if (rows[0].n === 0) await seedClubs(pool);
  })().catch((e) => { ready = null; throw e; }));
  setTimeout(() => { schema().catch((e) => console.warn('[GOLF] schema init failed:', e.message)); }, 22000);

  const guard = (perm) => async (req, res, next) => {
    try {
      if (!(await requirePerm(req, res, perm))) return;
      await schema();
      next();
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
  const use = [authenticateToken, guard(PERM_USE)];
  const manage = [authenticateToken, guard(PERM_MANAGE)];

  // Personnes à qui on peut confier des appels : détenteurs de la permission (via un rôle, ou
  // jokers « * ») + administrateurs. Chaque requête est isolée : une table absente n'invalide pas l'autre.
  const listAssignees = async () => {
    const people = new Map();
    const add = (email, name) => {
      const e = String(email || '').trim().toLowerCase();
      if (!e) return;
      if (!people.has(e) || (name && !people.get(e))) people.set(e, name || null);
    };
    try {
      const r = await pool.query(
        `SELECT DISTINCT LOWER(ur.user_email) AS email FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE r.permissions @> $1::jsonb OR r.permissions @> '["*"]'::jsonb`, [JSON.stringify([PERM_USE])]);
      r.rows.forEach((x) => add(x.email));
    } catch { /* pas de rôles : on continue */ }
    try { (await pool.query('SELECT email FROM user_tokens WHERE is_admin = TRUE')).rows.forEach((x) => add(x.email)); } catch { /* idem */ }
    const names = new Map();
    for (const tbl of ['user_tokens', 'local_users']) {
      try {
        (await pool.query(`SELECT LOWER(email) AS email, display_name FROM ${tbl} WHERE display_name IS NOT NULL`)).rows
          .forEach((x) => { if (x.display_name) names.set(x.email, x.display_name); });
      } catch { /* idem */ }
    }
    return [...people.keys()].sort().map((email) => ({ email, name: names.get(email) || null }));
  };
  // Confier un club à quelqu'un d'autre exige « manage » ; se l'attribuer ou se le retirer, « use » suffit.
  const mayAssign = async (req, to) => {
    const me = String(req.user.email || '').toLowerCase();
    if (to === null || to === me) return true;
    return req.user.isAdmin === true || (hasPerm ? await hasPerm(req, PERM_MANAGE) : false);
  };

  app.get('/api/golf-campaign/assignees', ...use, async (req, res) => {
    try { res.json({ people: await listAssignees() }); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Attribution en lot : { ids: [...], assigned_to: courriel | null }.
  app.post('/api/golf-campaign/assign', ...use, async (req, res) => {
    try {
      const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 500) : [];
      const to = req.body.assigned_to ? String(req.body.assigned_to).trim().toLowerCase() : null;
      if (!ids.length) return res.status(400).json({ error: 'invalid', fields: ['ids'] });
      if (to && !(await listAssignees()).some((p) => p.email === to)) return res.status(400).json({ error: 'unknown_assignee' });
      if (!(await mayAssign(req, to))) return res.status(403).json({ error: 'Permission required: ' + PERM_MANAGE });
      const r = await pool.query(
        'UPDATE golf_clubs SET assigned_to = $1, updated_at = NOW() WHERE id = ANY($2::uuid[]) RETURNING *', [to, ids]);
      res.json({ clubs: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/golf-campaign/clubs', ...use, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM golf_clubs ORDER BY name');
      res.json({ clubs: rows, statuses: STATUSES });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/golf-campaign/clubs', ...use, async (req, res) => {
    try {
      const name = text(req.body.name, 200);
      if (!name) return res.status(400).json({ error: 'invalid', fields: ['name'] });
      const r = await pool.query(
        `INSERT INTO golf_clubs (id, name, contact_name, email, phone, address, source)
         VALUES ($1,$2,$3,$4,$5,$6,'manual') ON CONFLICT (LOWER(name)) DO NOTHING RETURNING *`,
        [crypto.randomUUID(), name, text(req.body.contact_name, 200), text(req.body.email, 200),
          text(req.body.phone, 60), text(req.body.address, 300)]);
      if (!r.rows.length) return res.status(409).json({ error: 'exists' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/golf-campaign/clubs/:id', ...use, async (req, res) => {
    try {
      const b = req.body || {};
      const sets = []; const vals = [];
      const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'invalid', fields: ['status'] });
        add('status', b.status);
      }
      for (const k of ['callback_at', 'meeting_at']) {
        if (b[k] !== undefined) {
          const d = date(b[k]);
          if (d === undefined) return res.status(400).json({ error: 'invalid', fields: [k] });
          add(k, d);
        }
      }
      for (const [k, max] of [['contact_name', 200], ['email', 200], ['phone', 60], ['address', 300], ['notes', 5000]]) {
        if (b[k] !== undefined) add(k, text(b[k], max));
      }
      if (b.assigned_to !== undefined) {
        const to = b.assigned_to ? String(b.assigned_to).trim().toLowerCase() : null;
        if (to && !(await listAssignees()).some((p) => p.email === to)) return res.status(400).json({ error: 'unknown_assignee' });
        if (!(await mayAssign(req, to))) return res.status(403).json({ error: 'Permission required: ' + PERM_MANAGE });
        add('assigned_to', to);
      }
      if (b.answers !== undefined) {
        if (typeof b.answers !== 'object' || b.answers === null || Array.isArray(b.answers)) {
          return res.status(400).json({ error: 'invalid', fields: ['answers'] });
        }
        const clean = {};
        for (const [k, v] of Object.entries(b.answers)) if (v != null && String(v).trim()) clean[String(k).slice(0, 60)] = String(v).slice(0, 2000);
        add('answers', JSON.stringify(clean));
      }
      if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
      sets.push('updated_at = NOW()');
      vals.push(req.params.id);
      const r = await pool.query(`UPDATE golf_clubs SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
      if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Journalise un appel et met à jour le statut du club en une seule opération.
  app.post('/api/golf-campaign/clubs/:id/calls', ...use, async (req, res) => {
    try {
      const outcome = req.body.outcome;
      if (!STATUSES.includes(outcome)) return res.status(400).json({ error: 'invalid', fields: ['outcome'] });
      const cb = date(req.body.callback_at); const mt = date(req.body.meeting_at);
      if (cb === undefined || mt === undefined) return res.status(400).json({ error: 'invalid', fields: ['date'] });
      const email = (req.user.email || '').toLowerCase();
      const u = await pool.query(
        `UPDATE golf_clubs SET status = $2, last_call_at = NOW(), updated_at = NOW(),
                callback_at = $3, meeting_at = COALESCE($4, meeting_at),
                assigned_to = COALESCE(assigned_to, $5)
          WHERE id = $1 RETURNING *`,
        [req.params.id, outcome, outcome === 'callback' ? cb : null, mt, email]);
      if (!u.rows.length) return res.status(404).json({ error: 'not_found' });
      await pool.query(
        'INSERT INTO golf_call_log (id, club_id, by_email, outcome, note) VALUES ($1,$2,$3,$4,$5)',
        [crypto.randomUUID(), req.params.id, email, outcome, text(req.body.note, 2000)]);
      res.json(u.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/golf-campaign/clubs/:id/calls', ...use, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, by_email, outcome, note, created_at FROM golf_call_log WHERE club_id = $1 ORDER BY created_at DESC LIMIT 100',
        [req.params.id]);
      res.json({ calls: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/golf-campaign/questionnaire', ...use, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [SETTINGS_KEY]);
      res.json({ questions: Array.isArray(rows[0] && rows[0].value) ? rows[0].value : DEFAULT_QUESTIONNAIRE });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/golf-campaign/questionnaire', ...manage, async (req, res) => {
    try {
      const qs = req.body && req.body.questions;
      const ok = Array.isArray(qs) && qs.length > 0 && qs.length <= 40 && qs.every((q) =>
        q && /^[a-z0-9_]{1,40}$/.test(q.id || '') && ['choice', 'text', 'yesno'].includes(q.type)
        && q.label && typeof q.label.en === 'string' && typeof q.label.fr === 'string'
        && (q.type !== 'choice' || (Array.isArray(q.options) && q.options.length > 0)))
        && new Set(qs.map((q) => q.id)).size === qs.length;
      if (!ok) return res.status(400).json({ error: 'invalid' });
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [SETTINGS_KEY, JSON.stringify(qs)]);
      res.json({ questions: qs });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/golf-campaign/script', ...use, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [SCRIPT_KEY]);
      const v = rows[0] && rows[0].value;
      res.json({ script: v && typeof v.fr === 'string' && typeof v.en === 'string' ? v : DEFAULT_SCRIPT });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/golf-campaign/script', ...manage, async (req, res) => {
    try {
      const sc = req.body && req.body.script;
      const ok = sc && ['fr', 'en'].every((k) => typeof sc[k] === 'string' && sc[k].trim() && sc[k].length <= 2000);
      if (!ok) return res.status(400).json({ error: 'invalid' });
      const value = { fr: sc.fr.trim(), en: sc.en.trim() };
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [SCRIPT_KEY, JSON.stringify(value)]);
      res.json({ script: value });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Rejoue le chargement des clubs de départ (n'ajoute que les absents).
  app.post('/api/golf-campaign/seed', ...manage, async (req, res) => {
    try { res.json({ added: await seedClubs(pool) }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { registerGolfCampaignRoutes, ensureSchema, seedClubs, DEFAULT_QUESTIONNAIRE, DEFAULT_SCRIPT, STATUSES, PERM_USE, PERM_MANAGE };
