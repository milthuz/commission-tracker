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
  const mails = [];
  const sendMail = async (to, subject, html, opts = {}) => { mails.push({ to, subject, html, opts }); return { sent: true }; };
  const mailShell = (title, intro) => `<h1>${title}</h1>${intro}`;
  registerGolfCampaignRoutes(app, { authenticateToken, requirePerm, hasPerm, pool, sendMail, mailShell });
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


  // ── Rendez-vous en personne ──
  r = await call('GET', '/api/golf-campaign/visitor'); assert.strictEqual(r.j.visitor.email, 'david@clustersystems.com'); assert.strictEqual(r.j.calendarConnected, false);
  const clubs2 = (await call('GET', '/api/golf-campaign/clubs')).j.clubs;
  const withMail = clubs2.find((c) => c.email && c.name !== 'Golf Nouveau');
  const other = clubs2.find((c) => c.id !== withMail.id && c.name !== 'Golf Nouveau');
  r = await call('GET', `/api/golf-campaign/clubs/${withMail.id}/slots`);
  assert.strictEqual(r.s, 200); assert.strictEqual(r.j.source, 'saleshub'); assert.ok(r.j.days.length === 7 && r.j.days[0].slots.length + r.j.days[1].slots.length > 0, '7 jours ouvrables proposés');
  const slot = r.j.days.find((d) => d.slots.length).slots[0];
  r = await call('POST', `/api/golf-campaign/clubs/${withMail.id}/meeting`, { at: '2020-01-01T15:00:00Z' }); assert.strictEqual(r.s, 400, 'heure passée refusée');
  r = await call('POST', `/api/golf-campaign/clubs/${withMail.id}/meeting`, { at: new Date(Date.now() + 30 * 86400000 + 3 * 3600000).toISOString() }); assert.strictEqual(r.s, 409, 'hors des créneaux proposés');
  mails.length = 0;
  r = await call('POST', `/api/golf-campaign/clubs/${withMail.id}/meeting/preview`, { at: slot, lang: 'en', note: 'Veut voir la réservation' });
  assert.strictEqual(r.s, 200); assert.ok(/confirmed/i.test(r.j.client.subject) && r.j.client.to === withMail.email.split(/[\/;,]/)[0].trim() && r.j.client.html.includes('Meeting confirmed'), 'aperçu du courriel du club');
  assert.ok(r.j.visitor.subject.startsWith('Visite planifiée') && r.j.event.summary === `Visite — ${withMail.name}` && r.j.event.minutes === 60, 'aperçu du courriel du visiteur et de l’événement');
  assert.strictEqual(mails.length, 0, 'l’aperçu n’envoie rien');
  assert.strictEqual((await pool.query('SELECT status FROM golf_clubs WHERE id=$1', [withMail.id])).rows[0].status, 'to_call', 'l’aperçu ne réserve rien');
  r = await call('POST', `/api/golf-campaign/clubs/${withMail.id}/meeting/preview`, { at: '2020-01-01T15:00:00Z' }); assert.strictEqual(r.s, 400);
  r = await call('POST', `/api/golf-campaign/clubs/${withMail.id}/meeting/preview`, { at: slot, notify: false }); assert.strictEqual(r.j.client, null, 'sans envoi au club : pas de courriel du club dans l’aperçu');
  mails.length = 0;
  r = await call('POST', `/api/golf-campaign/clubs/${withMail.id}/meeting`, { at: slot, lang: 'en', note: 'Veut voir la réservation' });
  assert.strictEqual(r.s, 200); assert.strictEqual(r.j.club.status, 'meeting'); assert.strictEqual(r.j.club.meeting_with, 'david@clustersystems.com'); assert.strictEqual(r.j.calendar.skipped, 'google_not_configured');
  assert.strictEqual(mails.length, 2, 'un courriel au club, un au visiteur');
  const toClub = mails.find((m) => m.to === withMail.email.split(/[\/;,]/)[0].trim()); assert.ok(toClub && /confirmed/i.test(toClub.subject), 'courriel du club en anglais');
  assert.ok(toClub.opts.attachments[0].content.toString().includes('BEGIN:VCALENDAR') && toClub.opts.attachments[0].content.toString().includes('METHOD:PUBLISH'), 'fichier .ics joint');
  assert.ok(mails.some((m) => m.to === 'david@clustersystems.com' && m.subject.startsWith('Visite planifiée')), 'le visiteur reçoit le détail');
  r = await call('GET', `/api/golf-campaign/clubs/${withMail.id}/calls`); assert.ok(r.j.calls.some((c) => /Visite planifiée/.test(c.note)), 'inscrit au journal d’appels');
  r = await call('POST', `/api/golf-campaign/clubs/${other.id}/meeting`, { at: slot, notify: false }); assert.strictEqual(r.s, 409, 'même créneau, même visiteur : refusé'); assert.strictEqual(r.j.error, 'slot_taken');
  r = await call('GET', `/api/golf-campaign/clubs/${other.id}/slots`); assert.ok(!r.j.days.some((d) => d.slots.includes(slot)), 'le créneau pris disparaît pour les autres');
  r = await call('GET', `/api/golf-campaign/clubs/${withMail.id}/slots`); assert.ok(r.j.days.some((d) => d.slots.includes(slot)), 'mais reste disponible pour le club qui l’a (déplacement)');
  mails.length = 0;
  r = await call('DELETE', `/api/golf-campaign/clubs/${withMail.id}/meeting?lang=fr`);
  assert.strictEqual(r.s, 200); assert.strictEqual(r.j.club.status, 'interested'); assert.strictEqual(r.j.club.meeting_at, null); assert.strictEqual(r.j.club.meeting_with, null);
  assert.ok(mails.length === 1 && mails[0].opts.attachments[0].content.toString().includes('METHOD:CANCEL'), 'annulation envoyée avec .ics CANCEL');
  r = await call('POST', `/api/golf-campaign/clubs/${other.id}/meeting`, { at: slot, notify: false }); assert.strictEqual(r.s, 200, 'le créneau libéré peut être repris');
  mails.length = 0;
  granted.delete('golfcampaign:manage');
  r = await call('PUT', '/api/golf-campaign/visitor', { email: 'x@y.com', name: 'X', slotMinutes: 60 }); assert.strictEqual(r.s, 403, 'changer le visiteur exige manage');
  granted.add('golfcampaign:manage');
  r = await call('PUT', '/api/golf-campaign/visitor', { email: 'pas-un-courriel', name: 'X', slotMinutes: 60 }); assert.strictEqual(r.s, 400);
  r = await call('PUT', '/api/golf-campaign/visitor', { email: 'Jerome@Cluster.com', name: 'Jerome', slotMinutes: 45 }); assert.strictEqual(r.j.visitor.email, 'jerome@cluster.com'); assert.strictEqual(r.j.visitor.slotMinutes, 45);
  granted.delete('golfcampaign:manage');
  server.close(); console.log('golfCampaign : tous les tests passent');
  process.exit(0);
})().catch((e) => { console.error('ÉCHEC', e); process.exit(1); });
