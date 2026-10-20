// Campagne golf : parcours complet contre PGlite (base en mémoire) et un vrai serveur HTTP.
//   node services/golfCampaign/__tests__/routes.test.js
// ⚠️ Échoue si PGlite est absent plutôt que de se déclarer vert.
const assert = require('assert');
const http = require('http');
const express = require('express');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant'); process.exit(1); }
const { registerGolfCampaignRoutes, DEFAULT_QUESTIONNAIRE, DEFAULT_SCRIPT } = require('../routes');
const SEED = require('../seed.json');

(async () => {
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p) };
  await pool.query('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ)');
  await db.exec(`CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT, permissions JSONB);
    CREATE TABLE user_roles (user_email TEXT, role_id INT);
    CREATE TABLE user_tokens (email TEXT, is_admin BOOLEAN DEFAULT FALSE, display_name TEXT);`);
  await pool.query(`INSERT INTO roles (name, permissions) VALUES ('Caller', '["golfcampaign:use"]'), ('Other', '["invoices:view_all"]')`);
  await pool.query(`INSERT INTO user_roles VALUES ('Rep@Cluster.com', 1), ('amy@cluster.com', 1), ('bob@cluster.com', 2)`);
  await pool.query(`INSERT INTO user_tokens (email, is_admin, display_name) VALUES ('boss@cluster.com', TRUE, 'Le Boss'), ('amy@cluster.com', FALSE, 'Amy')`);
  const granted = new Set(['golfcampaign:use']);
  const app = express(); app.use(express.json());
  const authenticateToken = (req, _res, next) => { req.user = { email: 'Rep@Cluster.com' }; next(); };
  const requirePerm = async (req, res, perm) => { if (granted.has(perm)) return true; res.status(403).json({ error: 'Permission required: ' + perm }); return false; };
  const hasPerm = async (req, perm) => granted.has(perm);
  registerGolfCampaignRoutes(app, { authenticateToken, requirePerm, hasPerm, pool });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json() }; };

  let r = await call('GET', '/api/golf-campaign/clubs');
  assert.strictEqual(r.s, 200); assert.strictEqual(r.j.clubs.length, SEED.length, 'chargement initial complet');
  assert.ok(r.j.clubs.every((c) => c.status === 'to_call'));
  const club = r.j.clubs.find((c) => c.name === 'Club de Golf Alpin');
  assert.ok(club && club.gg_directory_name === 'Alpin' && club.email, 'club GGGolf avec contact');
  assert.ok(r.j.clubs.some((c) => c.is_cluster_client), 'clients Cluster marqués');

  r = await call('PUT', `/api/golf-campaign/clubs/${club.id}`, { status: 'bogus' }); assert.strictEqual(r.s, 400);
  r = await call('PUT', `/api/golf-campaign/clubs/${club.id}`, { answers: { platform: 'GGGolf', open: 'Yes', empty: '  ' }, notes: 'Veut une démo' });
  assert.strictEqual(r.s, 200); assert.deepStrictEqual(r.j.answers, { platform: 'GGGolf', open: 'Yes' }); assert.strictEqual(r.j.notes, 'Veut une démo');

  r = await call('POST', `/api/golf-campaign/clubs/${club.id}/calls`, { outcome: 'callback', callback_at: '2026-11-02T14:00:00Z', note: 'Rappeler lundi' });
  assert.strictEqual(r.s, 200); assert.strictEqual(r.j.status, 'callback'); assert.ok(r.j.callback_at && r.j.last_call_at); assert.strictEqual(r.j.assigned_to, 'rep@cluster.com');
  r = await call('POST', `/api/golf-campaign/clubs/${club.id}/calls`, { outcome: 'meeting', meeting_at: '2026-11-05T15:00:00Z' });
  assert.strictEqual(r.j.status, 'meeting'); assert.strictEqual(r.j.callback_at, null, 'le rappel est effacé une fois le rdv pris'); assert.ok(r.j.meeting_at);
  r = await call('GET', `/api/golf-campaign/clubs/${club.id}/calls`); assert.strictEqual(r.j.calls.length, 2);
  r = await call('POST', `/api/golf-campaign/clubs/${club.id}/calls`, { outcome: 'nope' }); assert.strictEqual(r.s, 400);
  r = await call('POST', `/api/golf-campaign/clubs/00000000-0000-0000-0000-000000000000/calls`, { outcome: 'no_answer' }); assert.strictEqual(r.s, 404);

  r = await call('GET', '/api/golf-campaign/assignees');
  assert.deepStrictEqual(r.j.people, [{ email: 'amy@cluster.com', name: 'Amy' }, { email: 'boss@cluster.com', name: 'Le Boss' }, { email: 'rep@cluster.com', name: null }], 'détenteurs de la permission + admins, sans bob');
  r = await call('PUT', `/api/golf-campaign/clubs/${club.id}`, { assigned_to: 'amy@cluster.com' }); assert.strictEqual(r.s, 403, 'confier à un autre exige manage');
  r = await call('PUT', `/api/golf-campaign/clubs/${club.id}`, { assigned_to: 'rep@cluster.com' }); assert.strictEqual(r.s, 200); assert.strictEqual(r.j.assigned_to, 'rep@cluster.com', 'se l’attribuer suffit avec use');
  r = await call('PUT', `/api/golf-campaign/clubs/${club.id}`, { assigned_to: null }); assert.strictEqual(r.j.assigned_to, null, 'se retirer un club');
  r = await call('POST', '/api/golf-campaign/assign', { ids: [club.id], assigned_to: 'amy@cluster.com' }); assert.strictEqual(r.s, 403);
  granted.add('golfcampaign:manage');
  r = await call('PUT', `/api/golf-campaign/clubs/${club.id}`, { assigned_to: 'bob@cluster.com' }); assert.strictEqual(r.s, 400, 'bob n’a pas la permission : pas assignable');
  r = await call('POST', '/api/golf-campaign/assign', { ids: [club.id, 'pas-un-uuid'], assigned_to: 'amy@cluster.com' }); assert.strictEqual(r.s, 200); assert.strictEqual(r.j.clubs.length, 1); assert.strictEqual(r.j.clubs[0].assigned_to, 'amy@cluster.com');
  granted.delete('golfcampaign:manage');
  r = await call('POST', '/api/golf-campaign/clubs', { name: 'club de golf alpin' }); assert.strictEqual(r.s, 409, 'doublon refusé sans tenir compte de la casse');
  r = await call('POST', '/api/golf-campaign/clubs', { name: 'Golf Nouveau' }); assert.strictEqual(r.s, 200);

  r = await call('GET', '/api/golf-campaign/questionnaire'); assert.deepStrictEqual(r.j.questions, DEFAULT_QUESTIONNAIRE);
  r = await call('PUT', '/api/golf-campaign/questionnaire', { questions: [] }); assert.strictEqual(r.s, 403, 'modifier le questionnaire exige manage');
  r = await call('POST', '/api/golf-campaign/seed'); assert.strictEqual(r.s, 403);
  r = await call('PUT', '/api/golf-campaign/script', { script: { fr: 'a', en: 'b' } }); assert.strictEqual(r.s, 403, 'modifier l’accroche exige manage');
  granted.add('golfcampaign:manage');
  r = await call('PUT', '/api/golf-campaign/questionnaire', { questions: [{ id: 'q1', type: 'choice', label: { en: 'A', fr: 'B' } }] }); assert.strictEqual(r.s, 400, 'choix sans options refusé');
  const q = [{ id: 'q1', type: 'text', label: { en: 'A', fr: 'B' } }];
  r = await call('PUT', '/api/golf-campaign/questionnaire', { questions: q }); assert.strictEqual(r.s, 200);
  r = await call('GET', '/api/golf-campaign/questionnaire'); assert.deepStrictEqual(r.j.questions, q);
  r = await call('GET', '/api/golf-campaign/script'); assert.deepStrictEqual(r.j.script, DEFAULT_SCRIPT);
  r = await call('PUT', '/api/golf-campaign/script', { script: { fr: 'x', en: '' } }); assert.strictEqual(r.s, 400, 'accroche vide refusée');
  r = await call('PUT', '/api/golf-campaign/script', { script: { fr: ' Salut ', en: 'Hi' } }); assert.strictEqual(r.s, 200);
  r = await call('GET', '/api/golf-campaign/script'); assert.deepStrictEqual(r.j.script, { fr: 'Salut', en: 'Hi' });
  r = await call('POST', '/api/golf-campaign/seed'); assert.strictEqual(r.j.added, 0, 'rejouer le chargement ne duplique rien');
  await pool.query(`DELETE FROM golf_clubs WHERE name = 'Club de Golf Acton Vale'`);
  r = await call('POST', '/api/golf-campaign/seed'); assert.strictEqual(r.j.added, 1, 'ne rajoute que le club manquant');
  const kept = (await pool.query(`SELECT status, notes FROM golf_clubs WHERE id=$1`, [club.id])).rows[0];
  assert.strictEqual(kept.status, 'meeting', 'le travail des reps survit au rechargement');

  server.close(); console.log('golfCampaign : tous les tests passent');
  process.exit(0);
})().catch((e) => { console.error('ÉCHEC', e); process.exit(1); });
