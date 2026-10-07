// Lot 0 de bout en bout, contre une vraie base Postgres en mémoire (PGlite) et un vrai serveur
// HTTP. Kaizen, Zoho Billing/Books et Google sont simulés.
//   npm install --no-save @electric-sql/pglite   (une fois)
//   node services/opener/__tests__/routes.test.js
//
// ⚠️ Échoue si PGlite est absent plutôt que de se déclarer vert (voir feedback-verify-the-harness).
const assert = require('assert');
const http = require('http');
const express = require('express');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant (npm install --no-save @electric-sql/pglite)'); process.exit(1); }
const { registerOpenerRoutes } = require('../routes');

const U = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const kStore = (i, name, street, postal, extra = {}) => ({
  uuid: U(i), name, store_id: `ORG-${i}`,
  address: { street, unit: '', city: 'Montreal', region: 'Quebec', postalCode: postal, country: 'Canada' },
  active: true, ...extra,
});
const gPlace = (id, name, postal, num, extra = {}) => ({
  id, displayName: { text: name }, formattedAddress: `${num} Rue, Montréal ${postal}`,
  location: { latitude: 45.5, longitude: -73.6 },
  primaryType: 'restaurant', types: ['restaurant', 'food', 'point_of_interest', 'establishment'],
  addressComponents: [{ types: ['street_number'], shortText: num }, { types: ['postal_code'], shortText: postal }],
  ...extra,
});
const CA = '697704869', XP = '905113716', US = '802470810';
const sub = (org, cid, name, status, plan = 'Cluster POS Mensuel') => ({ org, customer_id: cid, customer_name: name, status, plan_name: plan, subscription_number: `SUB-${cid}-${status}` });
const addr = (address, zip, extra = {}) => ({ address, street2: '', city: 'Montréal', state: 'Quebec', zip, country: 'Canada', ...extra });

(async () => {
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p).then((r) => ({ ...r, rowCount: r.affectedRows ?? r.rows.length })) };
  await db.exec(`
    CREATE TABLE sync_state (key VARCHAR(100) PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, metadata JSONB);
  `);
  // Ancienne table du premier déploiement, avec une décision humaine à reprendre.
  await db.exec(`
    CREATE TABLE kaizen_stores (uuid UUID PRIMARY KEY, store_id VARCHAR(60), name VARCHAR(255) NOT NULL, street VARCHAR(255), unit VARCHAR(60),
      city VARCHAR(120), region VARCHAR(120), postal_code VARCHAR(20), country VARCHAR(60), active BOOLEAN NOT NULL DEFAULT true,
      addr_key VARCHAR(500), missing_since TIMESTAMP, first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, match_status VARCHAR(12) NOT NULL DEFAULT 'pending', place_id VARCHAR(300),
      match_score NUMERIC(4,3), match_candidates JSONB, match_attempted_at TIMESTAMP, matched_by VARCHAR(255), matched_at TIMESTAMP,
      match_note VARCHAR(200), match_version SMALLINT NOT NULL DEFAULT 1);
    INSERT INTO kaizen_stores (uuid, name, street, city, postal_code, addr_key, match_status, matched_by)
      VALUES ('${U(9)}', 'Ancien Ignoré', '9 Rue Vieille', 'Montreal', 'H1A 1A1', '9 rue vieille||montreal||h1a1a1', 'ignored', 'david@x.com');
  `);

  // --- Kaizen simulé : le parc change d'un appel à l'autre.
  let parc = [
    kStore(1, 'Restaurant Saoko Inc.', '4520 Rue Saint-Denis', 'H2J 2L3'),
    kStore(2, 'Pizza Nova', '100 Rue Laurier', 'H2T 1A1'),          // deux fiches Google identiques
    kStore(3, 'Entrepôt test', '', '', { address: {} }),             // sans adresse
    kStore(4, 'Bistro Fermé', '9 Rue Rachel', 'H2W 1A1', { active: false }),
    kStore(5, 'Introuvable', '1 Rue Nulle', 'H0H 0H0'),
    kStore(9, 'Ancien Ignoré', '9 Rue Vieille', 'H1A 1A1'),
  ];
  let kaizenCalls = 0;
  const kaizen = { fetchAllStores: async () => { kaizenCalls++; return parc.concat([{ uuid: 'pas-un-uuid' }]); } };

  // --- Zoho Billing / Books simulés.
  let subs = [
    sub(CA, 'C1', 'Saoko', 'live'),                                  // jumeau du Kaizen 1 → V2
    sub(CA, 'C2', '9123-4567 Québec Inc.', 'live'),                  // société à numéro → par l'adresse
    sub(CA, 'C2', '9123-4567 Québec Inc.', 'cancelled', 'Ancien forfait'),
    sub(XP, 'X1', 'Chez Xperio', 'live'),                            // V1, organisation Xperio
    sub(CA, 'C3', 'Parti Depuis', 'cancelled'),                      // ancien client
    sub(CA, 'C4', 'Toronto Eats', 'live'),                           // hors Québec mais Canada
    sub(CA, 'C5', 'Boston Diner', 'live'),                           // adresse aux États-Unis
    sub(US, 'U1', 'Jamais Lu', 'live'),                              // org USA : jamais lue
  ];
  const contacts = {
    [`${CA}:C1`]: { shipping_address: addr('4520 Rue Saint-Denis', 'H2J 2L3'), billing_address: addr('1 Siège Social', 'H3B 1A1') },
    [`${CA}:C2`]: { shipping_address: {}, billing_address: addr('51 Westminster North', 'H4X 1Y8') },
    [`${XP}:X1`]: { shipping_address: addr('77 Rue Xperio', 'H2X 2X2') },
    [`${CA}:C3`]: { billing_address: addr('3 Rue Partie', 'H2A 3A3') },
    [`${CA}:C4`]: { billing_address: addr('10 King St', 'M5H 1A1', { state: 'Ontario', city: 'Toronto' }) },
    [`${CA}:C5`]: { billing_address: addr('1 Main St', '02101', { country: 'United States', state: 'MA', city: 'Boston' }) },
  };
  const booksCalls = [];
  let booksQuotaAfter = Infinity;
  const books = {
    fetchContact: async (_d, _t, orgId, cid) => {
      booksCalls.push(`${orgId}:${cid}`);
      if (booksCalls.length > booksQuotaAfter) { const e = new Error('quota'); e.quota = true; throw e; }
      const c = contacts[`${orgId}:${cid}`];
      if (!c) { const e = new Error(`Books contact ${cid} : HTTP 404`); e.status = 404; throw e; }
      return c;
    },
  };
  let zohoLockBusy = false;
  const billingFetches = [];
  const late = () => ({
    ACTIVE_STATUSES: new Set(['live', 'non_renewing', 'dunning', 'unpaid', 'paused']),
    getAdminBooksAuth: async () => ({ accessToken: 'T', apiDomain: 'https://z.test' }),
    fetchBillingSubs: async (_d, _t, orgId) => { billingFetches.push(orgId); return subs.filter((s) => s.org === orgId); },
    acquireSaasScanLock: async () => (zohoLockBusy ? null : 'owner-1'),
    saasScanShouldStop: async () => false,
    saasScanLockHolder: async () => (zohoLockBusy ? { label: 'base_price_scan' } : null),
    releaseSaasScanLock: async () => {},
  });

  // --- Google simulé : réponses par mot-clé de la requête (le plus long l'emporte).
  const googleCalls = [];
  const db_g = {
    Saoko: [gPlace('PLACE_SAOKO_0001', 'Saoko', 'H2J 2L3', '4520'), gPlace('PLACE_SAOKO_9999', 'Saoko Centre-Ville', 'H3B 1A1', '1000')],
    'Pizza Nova': [gPlace('PLACE_NOVA_00001', 'Pizza Nova', 'H2T 1A1', '100'), gPlace('PLACE_NOVA_00002', 'Pizza Nova', 'H2T 1A1', '100')],
    Bistro: [gPlace('PLACE_BISTRO_001', 'Bistro Fermé', 'H2W 1A1', '9')],
    Introuvable: [],
    '9123-4567': [gPlace('ADDR_51_WESTMINSTER', '51 Westminster North', 'H4X 1Y8', '51', { primaryType: undefined, types: ['premise', 'geocode'] })],
    'restaurant, 51 Westminster': [gPlace('PLACE_DELICES_0001', 'Les Délices de Lauzon', 'H4X 1Y8', '51')],
    'Chez Xperio': [gPlace('PLACE_XPERIO_0001', 'Chez Xperio', 'H2X 2X2', '77')],
    'Parti Depuis': [gPlace('PLACE_PARTI_00001', 'Parti Depuis', 'H2A 3A3', '3')],
    'Toronto Eats': [gPlace('PLACE_TORONTO_001', 'Toronto Eats', 'M5H 1A1', '10')],
  };
  const google = {
    configured: () => true,
    searchText: async (q) => { googleCalls.push(q); const k = Object.keys(db_g).filter((x) => q.includes(x)).sort((a, b) => b.length - a.length)[0]; return k ? db_g[k] : []; },
    details: async (id) => Object.values(db_g).flat().find((p) => p.id === id) || null,
  };

  const app = express();
  app.use(express.json());
  const perms = { 'admin@x.com': ['opener:match'], 'rep@x.com': [] };
  app.use((req, _res, next) => { req.user = { email: req.headers['x-user'] }; next(); });
  const authenticateToken = (req, res, next) => (req.user.email ? next() : res.status(401).end());
  const requirePerm = async (req, res, p) => {
    if ((perms[req.user.email] || []).includes(p)) return true;
    res.status(403).json({ error: 'forbidden' }); return false;
  };
  const logs = [];
  const logActivity = async (...a) => { logs.push(a); };
  const mod = registerOpenerRoutes(app, {
    authenticateToken, requirePerm, pool, logActivity, kaizen, google, books, late,
    kaizenConfigured: () => true, sleep: async () => {}, paceMs: 0,
  });

  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const call = (method, path, body, user = 'admin@x.com') => new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({ port, path, method, headers: { 'x-user': user, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const byKey = async () => Object.fromEntries((await pool.query(
    `SELECT id, source, source_key, match_status, place_id, active, software_version, version_override, twin_of, match_note, missing_since, match_version, match_candidates, extra
       FROM cluster_locations`)).rows.map((r) => [r.source_key, r]));

  let n = 0;
  const t = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

  try {
    await t('sans opener:match → 403 partout', async () => {
      assert.strictEqual((await call('GET', '/api/opener/locations/status', undefined, 'rep@x.com')).status, 403);
      assert.strictEqual((await call('GET', '/api/opener/locations', undefined, 'rep@x.com')).status, 403);
      assert.strictEqual((await call('POST', '/api/opener/locations/sync', {}, 'rep@x.com')).status, 403);
      assert.strictEqual((await call('POST', '/api/opener/locations/1/version', { version: 'v1' }, 'rep@x.com')).status, 403);
    });

    let out;
    await t('reprise de kaizen_stores : la décision humaine est conservée', async () => {
      out = await mod.runAll({ source: 'test' });
      const k = await byKey();
      assert.strictEqual(k[U(9)].match_status, 'ignored');
      assert.strictEqual(k[U(9)].source, 'kaizen');
      assert.ok(!googleCalls.some((q) => q.includes('Ancien Ignoré')));
    });

    await t('Kaizen (V2) : chaque magasin dans le bon statut', async () => {
      assert.strictEqual(out.sync.fetched, 7);
      assert.strictEqual(out.sync.rejected, 1, 'la ligne sans uuid valide est rejetée');
      const k = await byKey();
      assert.strictEqual(k[U(1)].match_status, 'auto');
      assert.strictEqual(k[U(1)].place_id, 'PLACE_SAOKO_0001');
      assert.strictEqual(k[U(2)].match_status, 'review', 'deux fiches identiques → humain');
      assert.strictEqual(k[U(3)].match_status, 'no_address');
      assert.strictEqual(k[U(4)].match_status, 'auto', 'un inactif s\'apparie aussi (ancien client)');
      assert.strictEqual(k[U(5)].match_status, 'none');
      for (const i of [1, 2, 3, 4, 5]) assert.strictEqual(k[U(i)].software_version, 'v2');
      assert.ok(!googleCalls.some((q) => q.includes('Entrepôt')), 'aucun appel Google sans adresse');
    });

    await t('Billing : Cluster Canada + Xperio seulement, adresse de LIVRAISON d\'abord', async () => {
      assert.deepStrictEqual([...new Set(billingFetches)].sort(), [CA, XP].sort(), 'Cluster USA n\'est jamais lue');
      assert.ok(!booksCalls.some((c) => c.startsWith(US)));
      const k = await byKey();
      assert.ok(k[`${CA}:C1`], 'client Saoko importé');
      const row = (await pool.query(`SELECT street FROM cluster_locations WHERE source_key = $1`, [`${CA}:C1`])).rows[0];
      assert.strictEqual(row.street, '4520 Rue Saint-Denis', 'livraison, pas le siège social');
      assert.strictEqual(out.billing.customers, 6);
      assert.strictEqual(out.billing.outsideCanada, 1, 'Boston écarté');
      assert.ok(!k[`${CA}:C5`]);
      assert.ok(k[`${CA}:C4`], 'Toronto est au Canada');
    });

    await t('jumeau : le client Billing de Saoko est V2, reçoit la fiche du Kaizen, sans recherche Google', async () => {
      const k = await byKey();
      const c1 = k[`${CA}:C1`];
      assert.strictEqual(c1.software_version, 'v2');
      assert.strictEqual(c1.twin_of, k[U(1)].id);
      assert.strictEqual(c1.place_id, 'PLACE_SAOKO_0001');
      assert.strictEqual(googleCalls.filter((q) => q.startsWith('Saoko')).length, 0, 'aucune recherche au nom « Saoko »');
    });

    await t('V1 : un client Billing sans jumeau Kaizen ; ancien client = inactif', async () => {
      const k = await byKey();
      assert.strictEqual(k[`${XP}:X1`].software_version, 'v1');
      assert.strictEqual(k[`${XP}:X1`].match_status, 'auto');
      assert.strictEqual(k[`${XP}:X1`].extra.org, 'Xperio POS');
      assert.strictEqual(k[`${CA}:C3`].active, false, 'abonnement résilié = ancien client');
      assert.strictEqual(k[`${CA}:C2`].active, true, 'un abonnement actif suffit');
      assert.deepStrictEqual(k[`${CA}:C2`].extra.plans.sort(), ['Ancien forfait', 'Cluster POS Mensuel']);
    });

    await t('société à numéro : l\'immeuble est écarté, le restaurant trouvé par l\'adresse', async () => {
      const c2 = (await byKey())[`${CA}:C2`];
      assert.strictEqual(c2.match_status, 'review');
      assert.deepStrictEqual(c2.match_candidates.map((c) => c.id), ['PLACE_DELICES_0001']);
    });

    await t('statut : compteurs par source et par version', async () => {
      const r = await call('GET', '/api/opener/locations/status');
      assert.strictEqual(r.status, 200);
      const tt = r.body.totals;
      assert.strictEqual(tt.kaizen, 6);
      assert.strictEqual(tt.billing, 5);
      assert.strictEqual(tt.twins, 1);
      assert.strictEqual(tt.v2, 7, '6 Kaizen + 1 jumeau');
      assert.strictEqual(tt.v1, 4);
      assert.strictEqual(r.body.configured.billing, true);
      assert.strictEqual(r.body.running, false);
      assert.strictEqual(r.body.lastRun.source, 'test');
    });

    await t('progression : chaque phase écrite pendant la synchro, montrée seulement pendant qu\'elle tourne', async () => {
      // Kaizen lent : on lit l'état PENDANT le passage.
      const real = kaizen.fetchAllStores;
      let release; const gate = new Promise((r) => { release = r; });
      kaizen.fetchAllStores = async () => { await gate; return real(); };
      const running = mod.runAll({ source: 'prog', budget: 1 });
      await new Promise((r) => setTimeout(r, 50));
      const during = await call('GET', '/api/opener/locations/status');
      assert.strictEqual(during.body.running, true);
      assert.strictEqual(during.body.progress.phase, 'kaizen');
      release();
      await running;
      kaizen.fetchAllStores = real;
      const after = await call('GET', '/api/opener/locations/status');
      assert.strictEqual(after.body.running, false);
      assert.strictEqual(after.body.progress, null);
      const last = JSON.parse((await pool.query(`SELECT value FROM sync_state WHERE key = 'opener_locations_progress'`)).rows[0].value);
      assert.ok(['matching', 'twins'].includes(last.phase), last.phase);
    });

    await t('liste : filtres version et source ; « à traiter » d\'abord les « à confirmer »', async () => {
      const v1 = await call('GET', '/api/opener/locations?status=all&version=v1');
      assert.strictEqual(v1.body.total, 4);
      assert.ok(v1.body.locations.every((l) => l.version === 'v1' && l.source === 'billing'));
      const kz = await call('GET', '/api/opener/locations?status=all&source=kaizen');
      assert.strictEqual(kz.body.total, 6);
      const todo = await call('GET', '/api/opener/locations?status=todo');
      assert.strictEqual(todo.body.locations[0].status, 'review');
      const tw = (await call('GET', '/api/opener/locations?status=all&q=4520')).body.locations.find((l) => l.source === 'billing');
      assert.strictEqual(tw.twin.storeName, 'Restaurant Saoko Inc.');
      assert.ok(tw.sourceLabel.includes('Cluster Canada'));
      assert.strictEqual((await call('GET', '/api/opener/locations?q=h2j2l3')).body.total, 2, 'recherche par code postal sans espace');
    });

    await t('confirmer un candidat → manuel, coordonnées, journal', async () => {
      const id = (await byKey())[U(2)].id;
      const r = await call('POST', `/api/opener/locations/${id}/confirm`, { placeId: 'PLACE_NOVA_00002' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.location.status, 'manual');
      assert.strictEqual(r.body.location.candidates.length, 0, 'les données Google en attente sont effacées');
      assert.strictEqual(r.body.location.lat, 45.5);
      assert.ok(logs.some((l) => l[0] === 'cluster_location' && l[2] === 'matched' && l[1] === id));
      assert.strictEqual((await call('POST', `/api/opener/locations/${id}/confirm`, { placeId: 'PLACE_INEXISTANT' })).status, 400);
      assert.strictEqual((await call('POST', `/api/opener/locations/abc/confirm`, { placeId: 'PLACE_NOVA_00002' })).status, 404);
    });

    await t('confirmer le restaurant d\'un V1 qui est en fait le même lieu qu\'un Kaizen → devient V2', async () => {
      const k = await byKey();
      // Le Kaizen « Introuvable » et le client C2 sont en réalité le même restaurant.
      await call('POST', `/api/opener/locations/${k[U(5)].id}/confirm`, { placeId: 'PLACE_DELICES_0001' });
      const r = await call('POST', `/api/opener/locations/${k[`${CA}:C2`].id}/confirm`, { placeId: 'PLACE_DELICES_0001' });
      assert.strictEqual(r.body.location.version, 'v2');
      assert.ok(r.body.location.twin);
    });

    await t('version imposée à la main, puis rendue à la déduction', async () => {
      const id = (await byKey())[`${XP}:X1`].id;
      let r = await call('POST', `/api/opener/locations/${id}/version`, { version: 'v2' });
      assert.strictEqual(r.body.location.version, 'v2');
      assert.strictEqual(r.body.location.versionAuto, 'v1');
      await mod.runAll({ source: 'apres-override' });
      assert.strictEqual((await byKey())[`${XP}:X1`].version_override, 'v2', 'la synchro ne défait pas un choix humain');
      r = await call('POST', `/api/opener/locations/${id}/version`, { version: null });
      assert.strictEqual(r.body.location.version, 'v1');
      assert.strictEqual((await call('POST', `/api/opener/locations/${id}/version`, { version: 'v3' })).status, 400);
    });

    await t('ignorer et remettre en file', async () => {
      const k = await byKey();
      assert.strictEqual((await call('POST', `/api/opener/locations/${k[U(3)].id}/ignore`, { reason: 'Magasin test' })).status, 200);
      let row = (await byKey())[U(3)];
      assert.deepStrictEqual([row.match_status, row.match_note], ['ignored', 'Magasin test']);
      assert.strictEqual((await call('POST', `/api/opener/locations/${k[U(4)].id}/reset`)).status, 200);
      row = (await byKey())[U(4)];
      assert.strictEqual(row.match_status, 'pending');
    });

    await t('2e synchro : manuel et ignoré intacts ; adresse changée → auto remis en jeu', async () => {
      parc = parc.map((s) => (s.uuid === U(1) ? { ...s, address: { ...s.address, street: '4600 Rue Saint-Denis' } } : s));
      parc = parc.map((s) => (s.uuid === U(2) ? { ...s, address: { ...s.address, street: '102 Rue Laurier' } } : s));
      const before = googleCalls.length;
      out = await mod.runAll({ source: 'test2' });
      const k = await byKey();
      assert.strictEqual(k[U(2)].match_status, 'manual', 'décision humaine conservée');
      assert.strictEqual(k[U(2)].place_id, 'PLACE_NOVA_00002');
      assert.ok(/Adresse modifiée/.test(k[U(2)].match_note), 'mais signalée');
      assert.strictEqual(k[U(3)].match_status, 'ignored');
      assert.ok(googleCalls.slice(before).some((q) => q.includes('4600')), 'Saoko recherché à sa nouvelle adresse');
    });

    await t('adresses Books : gardées, pas relues au passage suivant', async () => {
      const before = booksCalls.length;
      await mod.runAll({ source: 'test3' });
      assert.strictEqual(booksCalls.length, before, 'aucune relecture avant 30 jours');
    });

    await t('nouveau client Billing : seule SON adresse est lue ; budget et quota respectés', async () => {
      subs.push(sub(CA, 'C6', 'Nouveau Un', 'live'), sub(CA, 'C7', 'Nouveau Deux', 'live'), sub(CA, 'C8', 'Nouveau Trois', 'live'));
      contacts[`${CA}:C6`] = { billing_address: addr('6 Rue Six', 'H2B 6B6') };
      contacts[`${CA}:C7`] = { billing_address: addr('7 Rue Sept', 'H2B 7B7') };
      contacts[`${CA}:C8`] = { billing_address: addr('8 Rue Huit', 'H2B 8B8') };
      let before = booksCalls.length;
      out = await mod.runAll({ source: 'budget', addressBudget: 1 });
      assert.strictEqual(booksCalls.length - before, 1);
      assert.strictEqual(out.billing.addressesPending, 2);
      before = booksCalls.length;
      booksQuotaAfter = booksCalls.length + 1;   // la 2e lecture tombe sur le quota
      out = await mod.runAll({ source: 'quota' });
      assert.strictEqual(out.billing.stopped, 'quota Zoho atteint');
      booksQuotaAfter = Infinity;
      out = await mod.runAll({ source: 'reprise' });
      assert.strictEqual(out.billing.addressesPending, 0);
      const k = await byKey();
      assert.ok(k[`${CA}:C6`] && k[`${CA}:C7`] && k[`${CA}:C8`]);
    });

    await t('lecture des adresses interrompue : les clients aux adresses DÉJÀ connues sont écrits quand même', async () => {
      // Vécu le 2026-10-06 : un passage tué à 1 208 adresses sur 1 500 n'avait créé aucun emplacement.
      await pool.query(`DELETE FROM cluster_locations WHERE source = 'billing'`);
      subs.push(sub(CA, 'C9', 'Jamais Lu Encore', 'live'));
      contacts[`${CA}:C9`] = { billing_address: addr('9 Rue Neuf', 'H2C 9C9') };
      // Une lecture d'adresse qui ne répond jamais = le processus tué en plein passage : on regarde
      // la base PENDANT que le passage est bloqué.
      const real = books.fetchContact;
      let release; const hang = new Promise((r) => { release = r; });
      books.fetchContact = async (...a) => { await hang; return real(...a); };
      const running = mod.runAll({ source: 'interrompu', budget: 1 });
      await new Promise((r) => setTimeout(r, 200));
      const k = await byKey();
      assert.ok(k[`${CA}:C1`] && k[`${XP}:X1`] && k[`${CA}:C6`], 'les adresses en cache ont donné leurs emplacements');
      assert.ok(!k[`${CA}:C9`], 'pas encore d\'adresse → pas encore d\'emplacement');
      release(); books.fetchContact = real;
      out = await running;
      out = await mod.runAll({ source: 'reprise2', budget: 1 });
      assert.ok((await byKey())[`${CA}:C9`], 'repris au passage suivant');
    });

    await t('verrou abandonné depuis plus de 5 min (passage tué) : repris', async () => {
      await pool.query(`INSERT INTO sync_state (key, value, updated_at) VALUES ('opener_locations_lock', 'running', CURRENT_TIMESTAMP - INTERVAL '6 minutes')
                        ON CONFLICT (key) DO UPDATE SET value = 'running', updated_at = CURRENT_TIMESTAMP - INTERVAL '6 minutes'`);
      assert.strictEqual((await call('GET', '/api/opener/locations/status')).body.running, false);
      assert.ok(await mod.runAll({ source: 'apres-mort', budget: 1 }));
      await pool.query(`UPDATE sync_state SET value = 'running', updated_at = CURRENT_TIMESTAMP - INTERVAL '2 minutes' WHERE key = 'opener_locations_lock'`);
      assert.strictEqual(await mod.runAll({ source: 'vivant', budget: 1 }), null, 'un verrou récent bloque toujours');
      await pool.query(`UPDATE sync_state SET value = 'idle' WHERE key = 'opener_locations_lock'`);
    });

    await t('Zoho occupé par un scan SaaS : Billing reporté, Kaizen et appariement tournent quand même', async () => {
      zohoLockBusy = true;
      const before = kaizenCalls;
      out = await mod.runAll({ source: 'busy' });
      assert.ok(/Zoho occupé.*base_price_scan/.test(out.billingError), out.billingError);
      assert.strictEqual(kaizenCalls, before + 1);
      assert.ok(out.match);
      const r = (await pool.query(`SELECT 1 FROM sync_state WHERE key = 'opener_locations_last_ok' AND value LIKE '%busy%'`)).rows;
      assert.strictEqual(r.length, 0, 'un passage sans Billing ne compte pas comme réussi');
      zohoLockBusy = false;
    });

    await t('client Billing résilié de partout → missing, jamais supprimé', async () => {
      subs = subs.filter((s) => s.customer_id !== 'C4');
      out = await mod.runAll({ source: 'missing-billing' });
      assert.strictEqual(out.billing.missing, 1);
      assert.ok((await byKey())[`${CA}:C4`].missing_since);
    });

    await t('« none » n\'est pas retenté avant 30 jours', async () => {
      const id = (await byKey())[U(4)].id;
      await pool.query(`UPDATE cluster_locations SET match_status = 'none', match_version = 2, match_attempted_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
      const before = googleCalls.length;
      await mod.runAll({ source: 'none1' });
      assert.ok(!googleCalls.slice(before).some((q) => q.includes('Bistro')));
      await pool.query(`UPDATE cluster_locations SET match_attempted_at = CURRENT_TIMESTAMP - INTERVAL '31 days' WHERE id = $1`, [id]);
      await mod.runAll({ source: 'none2' });
      assert.ok(googleCalls.slice(before).some((q) => q.includes('Bistro')));
    });

    await t('notation améliorée : les « à confirmer » / « non trouvés » d\'une version antérieure sont renotés une fois', async () => {
      const k = await byKey();
      await pool.query(`UPDATE cluster_locations SET match_status = 'none', match_version = 1, match_attempted_at = CURRENT_TIMESTAMP WHERE id = $1`, [k[U(4)].id]);
      await pool.query(`UPDATE cluster_locations SET match_version = 1 WHERE id = $1`, [k[U(2)].id]);   // manuel
      const before = googleCalls.length;
      await mod.runAll({ source: 'v2' });
      const again = googleCalls.slice(before);
      assert.ok(again.some((q) => q.includes('Bistro')), 'renoté malgré la fenêtre de 30 jours');
      assert.ok(!again.some((q) => q.includes('Pizza Nova')), 'le manuel n\'est pas recherché');
      const b2 = googleCalls.length;
      await mod.runAll({ source: 'v2-bis' });
      assert.ok(!googleCalls.slice(b2).some((q) => q.includes('Bistro')), 'une seule fois : pas de boucle');
    });

    await t('magasin disparu de Kaizen → missing_since, revenu → effacé', async () => {
      parc = parc.filter((s) => s.uuid !== U(5));
      out = await mod.runAll({ source: 'missing' });
      assert.strictEqual(out.sync.missing, 1);
      assert.ok((await byKey())[U(5)].missing_since);
      assert.strictEqual((await call('GET', '/api/opener/locations?status=missing')).body.total, 2, 'Kaizen + Billing');
      parc.push(kStore(5, 'Introuvable', '1 Rue Nulle', 'H0H 0H0'));
      await mod.runAll({ source: 'back' });
      assert.strictEqual((await byKey())[U(5)].missing_since, null);
    });

    await t('réponse Kaizen réduite de moitié → personne n\'est marqué disparu', async () => {
      const big = Array.from({ length: 30 }, (_, i) => kStore(100 + i, `Resto ${i}`, `${i} Rue A`, 'H1A 1A1'));
      parc = parc.concat(big);
      await mod.runAll({ source: 'big', budget: 1 });
      const keep = parc;
      parc = parc.slice(0, 10);
      out = await mod.runAll({ source: 'partial', budget: 1 });
      assert.strictEqual(out.sync.missingSkipped, true);
      assert.strictEqual(out.sync.missing, 0);
      parc = keep;
    });

    await t('Kaizen en panne → erreur rapportée, base intacte, verrou relâché', async () => {
      const real = kaizen.fetchAllStores;
      kaizen.fetchAllStores = async () => { throw new Error('Kaizen connexion : HTTP 401 — bad credentials'); };
      const count = (await pool.query(`SELECT COUNT(*)::int AS n FROM cluster_locations WHERE missing_since IS NULL`)).rows[0].n;
      out = await mod.runAll({ source: 'down', budget: 1 });
      assert.ok(/401/.test(out.syncError));
      assert.strictEqual((await pool.query(`SELECT COUNT(*)::int AS n FROM cluster_locations WHERE missing_since IS NULL`)).rows[0].n, count);
      assert.strictEqual((await pool.query(`SELECT value FROM sync_state WHERE key = 'opener_locations_lock'`)).rows[0].value, 'idle');
      kaizen.fetchAllStores = real;
    });

    await t('verrou : une 2e synchro simultanée est refusée', async () => {
      await pool.query(`UPDATE sync_state SET value = 'running', updated_at = CURRENT_TIMESTAMP WHERE key = 'opener_locations_lock'`);
      assert.strictEqual(await mod.runAll({ source: 'concurrent' }), null);
      assert.strictEqual((await call('POST', '/api/opener/locations/sync', {})).status, 409);
      await pool.query(`UPDATE sync_state SET updated_at = CURRENT_TIMESTAMP - INTERVAL '31 minutes' WHERE key = 'opener_locations_lock'`);
      assert.ok(await mod.runAll({ source: 'stale', budget: 1 }));
    });

    await t('passage planifié : sauté si la dernière synchro RÉUSSIE date de moins de 20 h', async () => {
      await mod.runAll({ source: 'ok', budget: 1 });
      const before = kaizenCalls;
      await mod.runNightly();
      assert.strictEqual(kaizenCalls, before, 'aucun appel juste après un passage réussi');
      await pool.query(`UPDATE sync_state SET updated_at = CURRENT_TIMESTAMP - INTERVAL '21 hours' WHERE key = 'opener_locations_last_ok'`);
      await mod.runNightly();
      assert.strictEqual(kaizenCalls, before + 1);
    });

    await t('un passage EN ÉCHEC ne repousse pas le suivant', async () => {
      await pool.query(`UPDATE sync_state SET updated_at = CURRENT_TIMESTAMP - INTERVAL '21 hours' WHERE key = 'opener_locations_last_ok'`);
      const real = kaizen.fetchAllStores;
      kaizen.fetchAllStores = async () => { throw new Error('Kaizen : identifiants absents'); };
      await mod.runNightly();
      kaizen.fetchAllStores = real;
      const before = kaizenCalls;
      await mod.runNightly();
      assert.strictEqual(kaizenCalls, before + 1);
    });

    await t('Google non activé → passage arrêté au premier échec', async () => {
      const real = google.searchText;
      let calls = 0;
      google.searchText = async () => { calls++; throw new Error("Google : « Places API (New) » n'est pas activée sur la clé GOOGLE_PLACES_API_KEY"); };
      await pool.query(`UPDATE cluster_locations SET match_status = 'pending' WHERE match_status = 'auto' AND source = 'kaizen'`);
      out = await mod.runAll({ source: 'nokey' });
      assert.strictEqual(calls, 1);
      assert.strictEqual(out.match.aborted, true);
      google.searchText = real;
    });

    console.log(`routes : ${n} tests OK (${kaizenCalls} appels Kaizen, ${booksCalls.length} contacts Books, ${googleCalls.length} appels Google simulés)`);
  } finally {
    server.close();
    await db.close();
  }
})().catch((e) => { console.error('ÉCHEC :', e); process.exit(1); });
