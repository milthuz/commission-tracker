// Rapport quotidien des openers : réglages, contenu, envoi automatique une fois par jour ouvrable.
// Vraie base Postgres en mémoire (PGlite), vrai serveur HTTP ; courriel simulé.
//   node services/opener/__tests__/report.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant'); process.exit(1); }
const { registerOpenerRoutes } = require('../routes');
const { registerOpenerFieldRoutes } = require('../field');
const { registerOpenerReport } = require('../report');

(async () => {
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p).then((r) => ({ ...r, rowCount: r.affectedRows ?? r.rows.length })) };
  await db.exec(`
    CREATE TABLE sync_state (key VARCHAR(100) PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, metadata JSONB);
    CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT, permissions JSONB);
    CREATE TABLE user_roles (user_email TEXT, role_id INT);
    CREATE TABLE user_tokens (email TEXT, display_name TEXT, is_admin BOOLEAN);
    CREATE TABLE local_users (email TEXT, display_name TEXT);
    CREATE TABLE leads (id SERIAL PRIMARY KEY, ref_code TEXT, business_name TEXT, status TEXT, interest JSONB, created_by TEXT, raw JSONB, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO user_tokens VALUES ('hao@x.com', 'Hao Nguyen', false), ('mgr@x.com', 'Marie Gestion', false);
    INSERT INTO roles (name, permissions) VALUES ('Opener', '["opener:field"]');
    INSERT INTO user_roles VALUES ('hao@x.com', 1);
  `);
  const mails = [];
  const late = () => ({
    sendMail: async (to, subject, html) => { mails.push({ to, subject, html }); return { sent: true }; },
    mailShell: (title, intro, cta, url) => `<h1>${title}</h1>${intro}<a href="${url}">${cta}</a>`,
  });
  // Horloge simulée : le worker décide selon l'heure de Montréal.
  let clock = new Date('2026-10-13T21:30:00Z'); // mardi 13 oct., 17 h 30 à Montréal
  const app = express();
  app.use(express.json());
  const perms = { 'mgr@x.com': ['opener:reports', 'opener:routes'], 'hao@x.com': ['opener:field'] };
  app.use((req, _res, next) => { req.user = { email: req.headers['x-user'] }; next(); });
  const authenticateToken = (req, res, next) => (req.user.email ? next() : res.status(401).end());
  const hasPerm = async (req, p) => (perms[req.user.email] || []).includes(p);
  const requirePerm = async (req, res, p) => { if (await hasPerm(req, p)) return true; res.status(403).json({ error: 'forbidden' }); return false; };
  const google = { configured: () => false };
  const lot0 = registerOpenerRoutes(app, { authenticateToken, requirePerm, pool, logActivity: async () => {}, kaizen: { fetchAllStores: async () => [] }, google, kaizenConfigured: () => false });
  const field = registerOpenerFieldRoutes(app, { authenticateToken, requirePerm, hasPerm, pool, logActivity: async () => {}, google, late, baseSchema: lot0.ensureReady });
  await field.schema();
  const report = registerOpenerReport(app, { authenticateToken, requirePerm, pool, logActivity: async () => {}, field, late, now: () => clock });

  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const call = (method, path, body, user = 'mgr@x.com') => new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({ port, path, method, headers: { 'x-user': user, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  let n = 0;
  const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

  // Une journée de Hao le mardi 13 : 3 arrêts — un client visité sur place, un prospect visité à
  // distance avec un lead, un fermé à l'arrivée.
  const D = '2026-10-13';
  const route = (await pool.query(`INSERT INTO opener_routes (name, route_date, opener_email, status, created_by) VALUES ('R13 · Île de Montréal', $1, 'hao@x.com', 'published', 'mgr@x.com') RETURNING id`, [D])).rows[0].id;
  const st = [];
  for (const [i, [pid, label, outcome, skip]] of [['P1', 'Pizzeria Bella', 'done', null], ['P2', 'Café Olimpico', 'done', null], ['P3', 'Chez Lucie', 'skipped', 'closed']].entries()) {
    st.push((await pool.query(`INSERT INTO opener_route_stops (route_id, place_id, position, label, outcome, skip_reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [route, pid, i + 1, label, outcome, skip])).rows[0].id);
  }
  await pool.query(`INSERT INTO cluster_locations (source, source_key, name, active, place_id, match_status, software_version) VALUES ('billing', 'b1', 'Bella inc.', true, 'P1', 'auto', 'v1')`);
  await pool.query(`INSERT INTO leads (ref_code, business_name, status, created_by, raw, created_at) VALUES ('L-00042', 'Café Olimpico', 'new', 'hao@x.com', '{"via":"opener"}', '2026-10-13T18:20:00')`);
  await pool.query(`INSERT INTO opener_checkins (id, place_id, route_stop_id, user_email, at, lat, lng, accuracy_m, distance_m, current_pos, service_type, interest_level,
      started_at, start_lat, start_lng, start_accuracy_m, start_distance_m, satisfaction, payments_by, notes)
    VALUES ('11111111-1111-4111-8111-111111111111', 'P1', $1, 'hao@x.com', '2026-10-13T14:20:00Z', 45.5, -73.6, 10, 20, 'Cluster', 'tables', 3,
      '2026-10-13T14:05:00Z', 45.5, -73.6, 8, 15, 2, 'other', 'Lent le vendredi soir')`, [st[0]]);
  await pool.query(`INSERT INTO opener_checkins (id, place_id, route_stop_id, user_email, at, lat, lng, accuracy_m, distance_m, current_pos, service_type, interest_level,
      started_at, start_lat, start_lng, start_accuracy_m, start_distance_m, decision_maker, lead_id)
    VALUES ('22222222-2222-4222-8222-222222222222', 'P2', $1, 'hao@x.com', '2026-10-13T18:22:00Z', 45.51, -73.6, 12, 900, 'Square', 'quick', 4,
      '2026-10-13T18:10:00Z', 45.51, -73.6, 12, 850, 'yes', 1)`, [st[1]]);

  try {
    await t('réglages : réservés à opener:reports ; courriels nettoyés ; heure bornée', async () => {
      assert.strictEqual((await call('GET', '/api/opener/report/settings', undefined, 'hao@x.com')).status, 403);
      const r = await call('PUT', '/api/opener/report/settings', { enabled: true, hour: 99, recipients: ['DAVID@x.com', 'pas un courriel', 'david@x.com'], openers: [] });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.settings, { enabled: true, hour: 22, recipients: ['david@x.com'], openers: [] });
      const g = (await call('GET', '/api/opener/report/settings')).body;
      assert.deepStrictEqual(g.openers.map((o) => o.name), ['Hao Nguyen'], 'les openers du sélecteur');
      await call('PUT', '/api/opener/report/settings', { enabled: true, hour: 18, recipients: ['david@x.com', 'amanda@x.com'], openers: [] });
    });

    await t('aperçu : chaque visite (heures, durée, vérification GPS, satisfaction, lead), non visités, totaux', async () => {
      const p = (await call('GET', `/api/opener/report/preview?date=${D}`)).body;
      assert.strictEqual(p.openers, 1);
      assert.ok(p.subject.includes('2 visites') && p.subject.includes('1 lead'), p.subject);
      const h = p.html;
      for (const s of ['Hao Nguyen', 'R13 · Île de Montréal', 'Pizzeria Bella', '(client)', '15 min', 'satisfaction 2/5', 'paiements : un autre',
        'Lent le vendredi soir', 'Café Olimpico', 'lead L-00042', 'À distance', '850 m', 'décideur rencontré', 'Chez Lucie', 'fermé à l\'arrivée',
        '2/3 arrêts visités', '1 sur place', '1 à distance', '27 min en visite']) {
        assert.ok(h.includes(s), `manque « ${s} »`);
      }
      assert.ok(h.includes('10 h 05') || h.includes('10:05'), 'heure d\'arrivée en heure de Montréal');
    });

    await t('« Envoyer maintenant » : aux destinataires choisis ; sans destinataire → refusé', async () => {
      mails.length = 0;
      const r = await call('POST', '/api/opener/report/send', { date: D });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(mails.length, 1);
      assert.strictEqual(mails[0].to, 'david@x.com,amanda@x.com');
      await call('PUT', '/api/opener/report/settings', { enabled: true, hour: 18, recipients: [], openers: [] });
      const none = await call('POST', '/api/opener/report/send', { date: D });
      assert.deepStrictEqual([none.status, none.body.error], [400, 'no_recipients']);
      assert.strictEqual(mails.length, 1, 'rien d\'envoyé sans destinataire');
      await call('PUT', '/api/opener/report/settings', { enabled: true, hour: 18, recipients: ['david@x.com', 'amanda@x.com'], openers: [] });
    });

    await t('automatique : pas avant l\'heure, puis UNE fois, jamais en double', async () => {
      mails.length = 0;
      clock = new Date('2026-10-13T21:30:00Z');  // 17 h 30 : trop tôt
      assert.strictEqual((await report.runDue()).skipped, 'too_early');
      clock = new Date('2026-10-13T22:05:00Z');  // 18 h 05
      const out = await report.runDue();
      assert.strictEqual(out.openers, 1, JSON.stringify(out));
      assert.strictEqual(mails.length, 1);
      assert.strictEqual((await report.runDue()).skipped, 'already_sent');
      assert.strictEqual(mails.length, 1);
    });

    await t('jour férié et fin de semaine : aucun rapport', async () => {
      clock = new Date('2026-10-12T22:30:00Z');  // lundi 12 oct. 2026, Action de grâce
      assert.strictEqual((await report.runDue()).skipped, 'not_workday');
      clock = new Date('2026-10-17T22:30:00Z');  // samedi
      assert.strictEqual((await report.runDue()).skipped, 'not_workday');
    });

    await t('désactivé : rien ; jour sans activité : rien d\'envoyé', async () => {
      await call('PUT', '/api/opener/report/settings', { enabled: false, hour: 18, recipients: ['david@x.com'], openers: [] });
      clock = new Date('2026-10-14T22:30:00Z');
      assert.strictEqual((await report.runDue()).skipped, 'disabled');
      await call('PUT', '/api/opener/report/settings', { enabled: true, hour: 18, recipients: ['david@x.com'], openers: [] });
      mails.length = 0;
      assert.strictEqual((await report.runDue()).skipped, 'no_activity');
      assert.strictEqual(mails.length, 0);
    });

    await t('seulement certains openers : un opener non choisi n\'apparaît pas', async () => {
      await call('PUT', '/api/opener/report/settings', { enabled: true, hour: 18, recipients: ['david@x.com'], openers: ['autre@x.com'] });
      const p = (await call('GET', `/api/opener/report/preview?date=${D}`)).body;
      assert.strictEqual(p.openers, 0);
      assert.ok(!p.html.includes('Hao Nguyen'));
    });

    console.log(`report : ${n} tests OK`);
  } catch (e) {
    console.error('ÉCHEC :', e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
