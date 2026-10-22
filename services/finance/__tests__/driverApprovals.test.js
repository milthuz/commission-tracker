// Approbation par driver, responsables par ligne et barre de progression (lot G), de bout en bout
// contre une vraie base Postgres en mémoire (PGlite) et un vrai serveur HTTP, sur le budget de la CFO
// importé tel quel (73 employés, 28 contractuels, tous les drivers et lignes OPEX).
//   npm install --no-save @electric-sql/pglite   (une fois)
//   node services/finance/__tests__/driverApprovals.test.js [dossier design/finance]
//
// Le dossier de passation (données réelles de la CFO) n'est PAS dans le dépôt : par défaut
// ../design/finance à côté du dépôt. ⚠️ Échoue s'il manque, plutôt que de se déclarer vert.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant (npm install --no-save @electric-sql/pglite)'); process.exit(1); }
const { registerFinanceRoutes, validateSection } = require('../routes');
const { importHandoff } = require('../import');
const { PROTO } = require('../handoff');
const C = require('../driverApprovalsCore');
const DA = require('../driverApprovals');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '../../../../design/finance'));
if (!fs.existsSync(path.join(DIR, PROTO))) { console.error(`ÉCHEC : paquet de passation introuvable dans ${DIR}`); process.exit(1); }

let n = 0;
const ok = (c, m) => { assert(c, m); n++; };
const sha = (values, g = 0) => crypto.createHash('sha256').update(JSON.stringify({ v: values, g })).digest('hex');

// ============================================================================ calculs purs
(() => {
  const v12 = (x) => Array(12).fill(x);
  ok(C.hashValues(v12(5)) === sha(v12(5)), 'hachage = SHA-256 de {v: 12 valeurs, g: croissance}');
  ok(C.hashValues(v12(5)) === C.hashValues(v12(5)) && C.hashValues(v12(5)).length === 64, 'hachage déterministe, 64 caractères hexadécimaux');
  ok(C.hashValues(v12(5)) !== C.hashValues(v12(5.01)), 'une valeur qui change = un autre hachage');
  ok(C.hashValues(v12(5)) === C.hashValues(v12(5.0000001)), 'arrondi au millionième : le bruit de virgule flottante ne périme rien');
  ok(C.hashValues(v12(0)) === C.hashValues(v12(-0)), '-0 et 0 : même hachage');
  const a = v12(1); const b = v12(1); b[3] = 2; const c = v12(1); c[4] = 2;
  ok(C.hashValues(a) !== C.hashValues(b) && C.hashValues(b) !== C.hashValues(c), 'l\'ordre des mois compte');
  ok(C.hashValues(v12(1), 0) !== C.hashValues(v12(1), 2), 'la croissance (OPEX) change le hachage');

  // applyGrowth : mêmes règles que model.ts (le banc frontend le compare au vrai modèle).
  ok(JSON.stringify(C.applyGrowth([10, 10, 10], {}, 0)) === '[10,10,10]', 'sans croissance : la base');
  ok(JSON.stringify(C.applyGrowth([10, 10, 10], { 1: 50 }, 0)) === '[10,50,10]', 'une cellule modifiée remplace le mois');
  const g = C.applyGrowth([100, 0, 0], {}, 10);
  ok(g[0] === 100 && Math.abs(g[1] - 110) < 1e-9 && Math.abs(g[2] - 121) < 1e-9, 'croissance composée à partir de janvier');
  ok(Math.abs(C.applyGrowth([100, 0, 0], { 0: 200 }, 10)[2] - 242) < 1e-9,'la croissance part de janvier SAISI');
  ok(C.applyGrowth([100, 0, 0], { 1: 7 }, 10)[1] === 7 && Math.abs(C.applyGrowth([100, 0, 0], { 1: 7 }, 10)[2] - 121) < 1e-9, 'une cellule saisie gagne sur la croissance');

  // États affichés.
  const row = (o) => ({ status: 'proposed', approved_hash: null, submitted_hash: null, ...o });
  ok(C.displayState(null, 'h', 'h') === 'default', 'jamais touchée, valeur par défaut : default');
  ok(C.displayState(null, 'x', 'h') === 'proposed', 'modifiée sans ligne : proposed');
  ok(C.displayState(row({ owner: 'x' }), 'h', 'h') === 'default', 'un responsable seul ne change pas l\'état');
  ok(C.displayState(row({ status: 'submitted', submitted_hash: 'x' }), 'x', 'h') === 'submitted', 'soumise, valeur inchangée : submitted');
  ok(C.displayState(row({ status: 'submitted', submitted_hash: 'x' }), 'y', 'h') === 'proposed', 'soumise puis modifiée : redevient proposed');
  ok(C.displayState(row({ status: 'approved', approved_hash: 'x' }), 'x', 'h') === 'approved', 'approuvée, inchangée : approved');
  ok(C.displayState(row({ status: 'approved', approved_hash: 'x' }), 'y', 'h') === 'stale', 'approuvée puis modifiée : stale');
  ok(C.displayState(row({ status: 'approved', approved_hash: 'h' }), 'h', 'h') === 'approved', 'les valeurs par défaut peuvent être approuvées');

  // Responsables et clés.
  ok(C.cleanOwner('  Amanda  ') === 'Amanda' && C.cleanOwner('A   B') === 'A B', 'responsable : espaces nettoyés');
  ok(C.cleanOwner('') === null && C.cleanOwner('   ') === null && C.cleanOwner(null) === null && C.cleanOwner(5) === null, 'responsable vide ou non texte : refusé');
  ok(C.cleanOwner('x'.repeat(80)) === 'x'.repeat(80) && C.cleanOwner('x'.repeat(81)) === null, 'responsable : 80 caractères au plus');
  ok(C.cleanOwner('<b>x</b>') === null && C.cleanOwner('a\u0007b') === null, 'responsable : ni chevrons ni caractères de contrôle');
  const known = new Set(['drv:a', 'drv:b']);
  ok(C.cleanKeys(['drv:a', 'drv:a', 'drv:b'], known).keys.length === 2, 'clés : doublons retirés');
  ok(C.cleanKeys([], known).error === 'bad_keys' && C.cleanKeys('drv:a', known).error === 'bad_keys' && C.cleanKeys([1], known).error === 'bad_keys', 'clés : liste vide ou mal formée refusée');
  ok(C.cleanKeys(['zzz'], known).error === 'unknown_line', 'clés : clé inconnue refusée');
  ok(C.cleanKeys(Array(501).fill('drv:a'), known).error === 'too_many_keys', 'clés : 500 au plus');

  // Pourcentage pondéré.
  const mk = (id, state, done, total) => C.makeItem(id, { state, done, total });
  ok(C.finalizeProgress([]).percent === 0 && C.finalizeProgress([]).ready === false, 'aucun point : 0 %, pas prêt');
  const pr = C.finalizeProgress([mk('drivers_revenue', 'todo', 1, 4), mk('books_connected', 'blocked', 0, 0)]);
  ok(pr.percent === Math.round(((2 * 0.25) / 3) * 100), 'pondération : requis = 2, facultatif = 1, part = fait ÷ total');
  ok(!pr.ready, 'un point obligatoire non fait : pas prêt');
  const all = C.ITEM_DEFS.map((d) => mk(d.id, 'done', 1, 1));
  ok(C.finalizeProgress(all).ready && C.finalizeProgress(all).percent === 100, 'tout fait : prêt, 100 %');
  const noFinal = C.ITEM_DEFS.map((d) => mk(d.id, d.final ? 'todo' : 'done', d.final ? 0 : 1, 1));
  ok(C.finalizeProgress(noFinal).ready && C.finalizeProgress(noFinal).percent < 100, 'prêt AVANT l\'approbation finale, mais pas 100 %');
  const optMissing = C.ITEM_DEFS.map((d) => mk(d.id, d.required ? 'done' : 'blocked', 1, 1));
  ok(C.finalizeProgress(optMissing).ready, 'un point facultatif bloqué (Books à reconnecter) n\'empêche pas d\'être prêt');
  let threw = false; try { C.makeItem('inconnu', { state: 'done' }); } catch { threw = true; }
  ok(threw, 'point de contrôle inconnu : erreur de programmation');
})();

// ============================================================================ de bout en bout
(async () => {
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p) };
  await db.exec(`
    CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, amount NUMERIC, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT UNIQUE, description TEXT, permissions JSONB, is_system BOOLEAN);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ);
  `);
  const FULL = ['finance:view', 'finance:edit', 'finance:payroll', 'finance:approve', 'finance:driver_approve', 'finance:progress'];
  const perms = {
    'cfo@x.com': FULL,
    'analyste@x.com': ['finance:view', 'finance:edit'],
    'approver@x.com': ['finance:view', 'finance:driver_approve'],
    'prog@x.com': ['finance:view', 'finance:progress'],
    'lecteur@x.com': ['finance:view'],
    'nobody@x.com': [],
  };
  const has = (req, p) => (perms[req.user.email] || []).includes(p);
  const logs = [];
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const authenticateToken = (req, res, next) => {
    const e = req.headers['x-test-user']; if (!e) return res.status(401).json({ error: 'auth' });
    req.user = { email: e, isAdmin: false, isDemo: req.headers['x-test-demo'] === '1' }; next();
  };
  registerFinanceRoutes(app, {
    authenticateToken, pool,
    hasPerm: async (req, p) => has(req, p),
    requirePerm: async (req, res, p) => { if (has(req, p)) return true; res.status(403).json({ error: 'perm' }); return false; },
    logActivity: async (t, id, ev, d, actor, extra = {}) => { logs.push({ t, id, ev, d, actor, extra }); },
  });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, user, body, extra = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const DS = '/api/finance/driver-status';

  // ---------------------------------------------------------------- avant l'import / permissions de lecture
  ok((await api('GET', DS, 'nobody@x.com')).status === 403, 'sans permission : 403');
  ok((await api('GET', DS, 'cfo@x.com', null, { 'x-test-demo': '1' })).status === 403, 'mode démo : bloqué');
  ok((await api('GET', DS, 'lecteur@x.com')).status === 403, 'finance:view seul : ni progression ni statuts');
  ok((await api('GET', DS, 'analyste@x.com')).status === 403, 'finance:edit sans finance:progress ni driver_approve : pas de lecture des statuts');
  ok((await api('GET', DS, 'prog@x.com')).body.empty === true, 'aucun budget importé : empty');
  ok((await api('GET', '/api/finance/progress', 'cfo@x.com')).body.empty === true, 'progression sans budget : empty');
  ok((await api('POST', `${DS}/approve`, 'cfo@x.com', { keys: ['drv:intAdds'] })).status === 404, 'approuver sans budget : 404');

  const imp = await importHandoff(pool, DIR, { apply: true, actor: 'test' });
  ok(imp.action === 'create', 'budget de la CFO importé');
  const cfoBudget = (await api('GET', '/api/finance/budget', 'cfo@x.com')).body;
  const id = cfoBudget.budget.id;
  const ref = cfoBudget.reference;
  const roster = cfoBudget.roster;

  // ---------------------------------------------------------------- les lignes suivies
  let g = await api('GET', DS, 'cfo@x.com');
  ok(g.status === 200 && !g.body.locked, 'CFO : lit les statuts');
  let L = g.body.lines;
  const by = (k) => L.find((l) => l.key === k);
  const rev = L.filter((l) => l.group === 'revenue'), cogs = L.filter((l) => l.group === 'cogs'), opx = L.filter((l) => l.group === 'opex');
  // 15 COGS + 7 de SH-49 (COGS de service en deux blocs).
  ok(rev.length === 30 && cogs.length === 22, `30 drivers de revenus et 22 de COGS saisissables (${rev.length}/${cogs.length})`);
  ok(opx.length > 20 && new Set(L.map((l) => l.key)).size === L.length, `${opx.length} lignes OPEX modifiables, clés uniques`);
  ok(['supportWages', 'supportContr', 'nnWages', 'exWages'].every((k) => !by(`drv:${k}`)), 'les lignes alimentées par la paie ne sont pas suivies');
  ok(Object.keys(ref.drvDefaults).every((k) => by(`drv:${k}`) || ['supportWages', 'supportContr', 'nnWages', 'exWages'].includes(k)), 'tout driver de la référence est suivi, sauf les 4 lignes de paie');
  // Les lignes OPEX suivies = exactement celles que validateSection accepte (routes.js).
  const editable = new Set(opx.map((l) => l.id));
  let same = true;
  for (const it of ref.opex) {
    if (it.t !== 'line') continue;
    const acc = typeof validateSection('opex', { opx: { [it.key]: { 0: 1 } }, opxG: {} }, ref) === 'object';
    if (acc !== editable.has(it.key)) same = false;
  }
  ok(same, 'lignes OPEX suivies = lignes que validateSection (phase 1) accepte');
  ok(L.every((l) => l.state === 'default' && !l.modified && !l.owner && l.version === 0 && l.values.length === 12), 'au départ : tout « default », sans responsable, version 0');
  ok(g.body.summary.total === L.length && g.body.summary.ownersMissing === L.length && g.body.summary.default === L.length, 'compteurs de départ');
  ok(g.body.directory.length === 5 && g.body.directory.includes('Amanda'), 'annuaire de départ : 5 responsables');
  ok(L.every((l) => g.body.directory.includes(l.suggestedOwner)), 'chaque ligne a un responsable SUGGÉRÉ qui est dans l\'annuaire');
  ok(by('drv:intAdds').suggestedOwner === 'David' && by('drv:svcSw').suggestedOwner === 'Eric', 'suggestions : ventes → David, livraison → Eric');
  // Répartition de la CFO (2026-10-21) : tous les COGS à Eric SAUF hébergement et outils (Fred),
  // versements récurrents (David), frais marchands et de plateforme de paiement (Amanda).
  const cogsOwner = Object.fromEntries(cogs.map((l) => [l.id, l.suggestedOwner]));
  ok(cogsOwner.hostingG === 'Fred', 'COGS : hébergement et outils → Fred');
  ok(cogsOwner.revShare === 'David' && cogsOwner.resellerSaasG === 'David', 'COGS : versement récurrent (SaaS des revendeurs × partage) → David');
  ok(cogsOwner.merchantFees === 'Amanda' && cogsOwner.platformFees === 'Amanda', 'COGS : frais marchands et de plateforme de paiement → Amanda');
  const eric = cogs.filter((l) => l.suggestedOwner === 'Eric').map((l) => l.id).sort();
  ok(eric.length === cogs.length - 5, `tous les autres COGS (${eric.length}) → Eric`);
  ok(['clusterHwPct', 'xperioHwPct', 'licPct', 'supportSw', 'halukPct', 'travel'].every((k) => cogsOwner[k] === 'Eric'), 'COGS matériel, licences, soutien, livraison → Eric (plus à la comptabilité)');
  ok(rev.every((l) => l.suggestedOwner === 'David'), 'tous les drivers de revenus → David');
  const gaRent = by('opx:gaRent'), smLine = opx.find((l) => l.dept === 'S&M'), rdLine = opx.find((l) => l.dept === 'R&D');
  ok(gaRent.suggestedOwner === 'Amanda' && smLine.suggestedOwner === 'David' && rdLine.suggestedOwner === 'Fred', 'suggestions OPEX : S&M → David, R&D → Fred, G&A → Amanda');
  ok(by('drv:intAdds').hash === sha(Array(12).fill(ref.drvDefaults.intAdds)), 'hachage d\'un driver par défaut = SHA-256 des 12 valeurs par défaut');

  // Capacités.
  ok(g.body.caps.canEdit && g.body.caps.canApprove, 'CFO : peut modifier et approuver');
  const ap = await api('GET', DS, 'approver@x.com');
  ok(ap.status === 200 && !ap.body.caps.canEdit && !ap.body.caps.canApprove, 'driver_approve sans finance:edit : lit, ne peut pas approuver');
  const pg = await api('GET', DS, 'prog@x.com');
  ok(pg.status === 200 && !pg.body.caps.canApprove, 'finance:progress : lit seulement');

  // Aucune donnée nominative.
  const leak = (obj) => {
    const raw = JSON.stringify(obj);
    if (raw.includes('"salary"') || raw.includes('"salaryBase"')) return 'salary';
    for (const p of [...roster.employees, ...roster.contractors]) for (const nm of [p.name, p.co]) if (nm && nm.length > 3 && raw.includes(nm)) return nm;
    return null;
  };
  ok(roster.employees.length === 73 && leak(g.body) === null, 'aucun nom ni salaire de l\'effectif dans la liste des statuts');

  // ---------------------------------------------------------------- état selon les VRAIES modifications (PUT state)
  const ver = { drivers: 0, opex: 0 };
  const putState = async (section, data) => {
    const r = await api('PUT', `/api/finance/budgets/${id}/state/${section}`, 'cfo@x.com', { data, version: ver[section] });
    ok(r.status === 200, `PUT ${section} : ${JSON.stringify(r.body)}`);
    ver[section] = r.body.version;
  };
  const reload = async () => { L = (await api('GET', DS, 'cfo@x.com')).body.lines; return L; };
  const def = ref.drvDefaults.intAdds;
  await putState('drivers', { drv: { intAdds: Array(12).fill(def + 6) } });
  await reload();
  ok(by('drv:intAdds').state === 'proposed' && by('drv:intAdds').modified, 'driver modifié : proposed');
  ok(by('drv:intAdds').hash === sha(Array(12).fill(def + 6)), 'hachage des valeurs courantes (calcul à la main)');
  ok(by('drv:resAdds').state === 'default', 'les autres drivers restent « default »');
  await putState('drivers', { drv: { intAdds: Array(12).fill(def) } });
  await reload();
  ok(by('drv:intAdds').state === 'default', 'remis à la valeur par défaut : de nouveau « default »');
  await putState('drivers', { drv: { intAdds: [...Array(11).fill(def), def + 1] } });
  await reload();
  const h1 = by('drv:intAdds').hash;
  ok(by('drv:intAdds').state === 'proposed' && by('drv:intAdds').values[11] === def + 1, 'un seul mois modifié : proposed');
  ok((await reload()) && by('drv:intAdds').hash === h1, 'hachage stable d\'une lecture à l\'autre');

  // ---------------------------------------------------------------- soumettre / approuver : qui peut quoi
  const post = (action, user, body) => api('POST', `${DS}/${action}`, user, body);
  const K = 'drv:intAdds';
  ok((await post('submit', 'lecteur@x.com', { keys: [K] })).status === 403, 'lecteur : ne peut pas soumettre');
  ok((await post('submit', 'approver@x.com', { keys: [K] })).status === 403, 'driver_approve sans edit : ne peut pas soumettre');
  ok((await post('approve', 'analyste@x.com', { keys: [K] })).status === 403, 'finance:edit sans driver_approve : ne peut pas approuver');
  ok((await post('approve', 'approver@x.com', { keys: [K] })).status === 403, 'driver_approve sans finance:edit : ne peut pas approuver');
  ok((await post('approve', 'prog@x.com', { keys: [K] })).status === 403 && (await post('reopen', 'analyste@x.com', { keys: [K], reason: 'abc' })).status === 403, 'progress seul / edit seul : ni approuver ni rouvrir');
  ok((await api('POST', `${DS}/approve`, 'cfo@x.com', { keys: [K] }, { 'x-test-demo': '1' })).status === 403, 'mode démo : écriture bloquée');
  ok(by(K).state === 'proposed', 'aucune de ces tentatives n\'a changé l\'état');

  let r = await post('submit', 'analyste@x.com', { keys: [K] });
  ok(r.status === 200 && r.body.changed[0] === K && r.body.lines[0].state === 'submitted' && r.body.lines[0].submittedBy === 'analyste@x.com', 'edit : soumet (état « submitted », qui)');
  ok(r.body.summary.submitted === 1, 'compteurs rendus avec la réponse');
  r = await post('submit', 'analyste@x.com', { keys: [K] });
  ok(r.body.skipped[0].reason === 'already_submitted' && !r.body.changed.length, 'soumettre deux fois : ignoré, dit pourquoi');
  await putState('drivers', { drv: { intAdds: [...Array(11).fill(def), def + 2] } });
  await reload();
  ok(by(K).state === 'proposed', 'soumise puis modifiée : revient à « proposed »');
  await post('submit', 'analyste@x.com', { keys: [K] });
  r = await post('approve', 'cfo@x.com', { keys: [K] });
  ok(r.status === 200 && r.body.lines[0].state === 'approved' && r.body.lines[0].approvedBy === 'cfo@x.com', 'CFO : approuve');
  ok(r.body.lines[0].hash === sha([...Array(11).fill(def), def + 2]), 'approbation = hachage des valeurs vues');
  ok((await post('approve', 'cfo@x.com', { keys: [K] })).body.skipped[0].reason === 'already_approved', 'approuver deux fois : ignoré');
  ok((await post('submit', 'analyste@x.com', { keys: [K] })).body.skipped[0].reason === 'already_approved', 'soumettre un driver approuvé : ignoré');

  // Modification après approbation → périmée.
  await putState('drivers', { drv: { intAdds: [...Array(11).fill(def), def + 3] } });
  await reload();
  ok(by(K).state === 'stale' && by(K).approvedBy === 'cfo@x.com', 'approuvé puis modifié : « stale » (à ré-approuver)');
  // Retour exact à la valeur approuvée : redevient approuvé (même hachage).
  await putState('drivers', { drv: { intAdds: [...Array(11).fill(def), def + 2] } });
  await reload();
  ok(by(K).state === 'approved', 'la valeur approuvée rétablie : de nouveau « approved »');
  await putState('drivers', { drv: { intAdds: [...Array(11).fill(def), def + 3] } });
  await reload();

  // ---------------------------------------------------------------- concurrence
  const seen = { hash: by(K).hash, version: by(K).version };
  await putState('drivers', { drv: { intAdds: [...Array(11).fill(def), def + 4] } }); // quelqu'un change la valeur
  r = await post('approve', 'cfo@x.com', { keys: [K], expect: { [K]: seen } });
  ok(r.status === 409 && r.body.error === 'conflict' && r.body.keys[0] === K, 'approuver une valeur que l\'approbateur n\'a plus sous les yeux : 409 conflict');
  await reload();
  ok(by(K).state === 'stale', 'rien n\'a été écrit par le refus');
  // Version de la ligne : quelqu'un d'autre a touché à la ligne (ici : responsable).
  const seen2 = { hash: by(K).hash, version: by(K).version };
  ok((await api('PUT', `${DS}/owner`, 'analyste@x.com', { keys: [K], owner: 'Jerome' })).status === 200, 'un autre usager confie la ligne à quelqu\'un');
  r = await post('approve', 'cfo@x.com', { keys: [K], expect: { [K]: seen2 } });
  ok(r.status === 409 && r.body.keys[0] === K, 'version de la ligne périmée : 409');
  // Tout ou rien : une clé périmée dans le lot empêche tout le lot.
  await reload();
  const A = 'drv:resAdds', B = K;
  r = await post('approve', 'cfo@x.com', { keys: [A, B], expect: { [B]: { version: by(B).version + 5 } } });
  ok(r.status === 409, 'lot avec une clé périmée : 409');
  await reload();
  ok(by(A).state === 'default' && by(A).version === 0, 'lot refusé : aucune autre ligne écrite');
  const fresh = { hash: by(K).hash, version: by(K).version };
  r = await post('approve', 'cfo@x.com', { keys: [K], expect: { [K]: fresh } });
  ok(r.status === 200 && r.body.lines[0].state === 'approved', 'avec les valeurs à jour : approuvé');
  ok(by(K).owner === 'Jerome' || r.body.lines[0].owner === 'Jerome', 'le responsable confié entre-temps est resté');

  // ---------------------------------------------------------------- OPEX : cellule + croissance
  await putState('opex', { opx: { gaRent: { 0: 30000 } }, opxG: { gaRent: 2 } });
  await reload();
  const rentBase = ref.opex.find((x) => x.key === 'gaRent');
  ok(by('opx:gaRent').state === 'proposed' && by('opx:gaRent').values[0] === 30000, 'OPEX modifié : proposed');
  ok(Math.abs(by('opx:gaRent').values[3] - 30000 * Math.pow(1.02, 3)) < 1e-6 && by('opx:gaRent').growth === 2, 'valeurs OPEX = croissance composée depuis janvier saisi');
  const exp = Array.from({ length: 12 }, (_, i) => Math.round((i === 0 ? 30000 : 30000 * Math.pow(1.02, i)) * 1e6) / 1e6);
  ok(by('opx:gaRent').hash === sha(exp, 2), 'hachage OPEX (valeurs + croissance) calculé à la main');
  ok(rentBase && by('opx:glRent') === undefined, 'les lignes inconnues ne sont pas suivies');
  r = await post('approve', 'cfo@x.com', { keys: ['opx:gaRent'] });
  ok(r.body.lines[0].state === 'approved', 'OPEX approuvé');
  await putState('opex', { opx: { gaRent: { 0: 30000 } }, opxG: { gaRent: 3 } });
  await reload();
  ok(by('opx:gaRent').state === 'stale', 'seule la croissance change : « stale » (le hachage la couvre)');

  // ---------------------------------------------------------------- rouvrir
  ok((await post('reopen', 'cfo@x.com', { keys: [K] })).body.error === 'bad_reason', 'rouvrir sans raison : refusé');
  ok((await post('reopen', 'cfo@x.com', { keys: [K], reason: 'ab' })).body.error === 'bad_reason', 'raison trop courte : refusé');
  r = await post('reopen', 'cfo@x.com', { keys: [K, 'drv:xpAdds'], reason: 'Hypothèse à revoir avec le gestionnaire' });
  ok(r.body.changed.length === 1 && r.body.lines[0].state === 'proposed' && !r.body.lines[0].approvedBy, 'rouvert : redevient « proposed », approbation effacée');
  ok(r.body.skipped[0].key === 'drv:xpAdds' && r.body.skipped[0].reason === 'not_reopenable', 'une ligne jamais approuvée ne se rouvre pas');
  const reopenLog = logs.find((l) => l.ev === 'reopened');
  ok(reopenLog && reopenLog.t === 'finance_driver_status' && reopenLog.extra.metadata.reason.startsWith('Hypothèse'), 'journal « reopened » avec la raison');
  ok(logs.some((l) => l.ev === 'approved' && l.extra.metadata.count >= 1) && logs.some((l) => l.ev === 'submitted'), 'journal : soumissions et approbations');
  ok(leak(logs) === null, 'le journal ne contient aucun nom ni salaire');

  // Approuver un lot de drivers par défaut (la CFO approuve « tous les drivers de la page »).
  const batch = (await reload()).filter((l) => l.group === 'cogs').map((l) => l.key);
  r = await post('approve', 'cfo@x.com', { keys: batch });
  ok(r.status === 200 && r.body.changed.length === 22 && r.body.summary.groups.cogs.approved === 22, 'approbation en lot : les 22 drivers de COGS');
  ok(r.body.lines.every((l) => l.state === 'approved'), 'valeurs par défaut approuvées telles quelles');

  // ---------------------------------------------------------------- verrou du budget entier
  r = await api('POST', `/api/finance/budgets/${id}/approve`, 'cfo@x.com');
  ok(r.status === 200 && r.body.budget.status === 'approved', 'budget entier approuvé (verrou)');
  for (const [action, body] of [['submit', { keys: [A] }], ['approve', { keys: [A] }], ['reopen', { keys: batch.slice(0, 1), reason: 'raison valable' }]]) {
    const x = await post(action, 'cfo@x.com', body);
    ok(x.status === 409 && x.body.error === 'locked', `budget verrouillé : ${action} → 409 locked`);
  }
  ok((await api('PUT', `${DS}/owner`, 'cfo@x.com', { keys: [A], owner: 'Eric' })).body.error === 'locked', 'budget verrouillé : responsable → 409 locked');
  ok((await api('POST', `${DS}/owners/confirm`, 'cfo@x.com', { keys: [A] })).status === 409, 'budget verrouillé : confirmation des responsables → 409');
  g = await api('GET', DS, 'cfo@x.com');
  ok(g.body.locked && !g.body.caps.canEdit && !g.body.caps.canApprove, 'budget verrouillé : lecture seule, capacités à zéro');
  ok((await api('POST', `/api/finance/budgets/${id}/unlock`, 'cfo@x.com')).body.budget.status === 'draft', 'déverrouillé');
  await reload();
  ok(by(batch[0]).state === 'approved', 'les approbations par driver survivent au verrou / déverrouillage');

  // ---------------------------------------------------------------- responsables
  const own = (user, body) => api('PUT', `${DS}/owner`, user, body);
  ok((await own('lecteur@x.com', { keys: [A], owner: 'Eric' })).status === 403, 'lecteur : ne peut pas assigner');
  ok((await own('cfo@x.com', { keys: [A], owner: 'x'.repeat(81) })).body.error === 'bad_owner', 'responsable de 81 caractères refusé');
  ok((await own('cfo@x.com', { keys: [A], owner: '<script>' })).body.error === 'bad_owner', 'responsable avec chevrons refusé');
  ok((await own('cfo@x.com', { keys: [A], owner: 'a\u0001b' })).body.error === 'bad_owner', 'responsable avec caractère de contrôle refusé');
  ok((await own('cfo@x.com', { keys: [A] })).body.error === 'bad_owner', 'responsable absent refusé');
  ok((await own('cfo@x.com', { keys: ['drv:pirate'], owner: 'Eric' })).body.error === 'unknown_line', 'clé inconnue refusée');
  ok((await own('cfo@x.com', { keys: [], owner: 'Eric' })).body.error === 'bad_keys' && (await own('cfo@x.com', { owner: 'Eric' })).body.error === 'bad_keys', 'liste de clés vide ou absente refusée');
  ok((await own('cfo@x.com', { keys: Array(501).fill(A), owner: 'Eric' })).body.error === 'too_many_keys', 'plus de 500 clés refusé');
  r = await own('analyste@x.com', { keys: [A, 'drv:xpAdds'], owner: 'Marc-Antoine' });
  ok(r.status === 200 && r.body.changed.length === 2 && r.body.lines.every((l) => l.owner === 'Marc-Antoine'), 'edit : assigne un responsable (texte libre)');
  ok(r.body.directory.includes('Marc-Antoine'), 'un nouveau responsable est mémorisé dans l\'annuaire');
  ok(r.body.lines[0].state === 'default', 'assigner un responsable ne change pas l\'état de la ligne');
  r = await own('cfo@x.com', { keys: [A], owner: null });
  ok(r.body.lines[0].owner === null && r.body.summary.ownersMissing > 0, 'effacer un responsable (null)');
  const missingBefore = (await reload()).filter((l) => !l.owner).length;
  r = await api('POST', `${DS}/owners/confirm`, 'cfo@x.com', { keys: L.map((l) => l.key) });
  ok(r.status === 200 && r.body.changed.length === missingBefore && r.body.skipped.every((s) => s.reason === 'has_owner'), 'confirmer les suggestions : seules les lignes sans responsable sont touchées');
  ok(r.body.summary.ownersMissing === 0, 'plus aucune ligne sans responsable');
  await reload();
  ok(by(A).owner === 'David' && by('drv:xpAdds').owner === 'Marc-Antoine' && by('opx:gaRent').owner === 'Amanda', 'suggestions enregistrées ; un responsable déjà confié n\'est pas écrasé');
  ok(by(K).owner === 'Jerome', 'un responsable déjà confirmé (Jerome) n\'est pas remplacé par la suggestion');
  ok(logs.some((l) => l.ev === 'owners_confirmed') && logs.some((l) => l.ev === 'owner_set'), 'journal : responsables');

  // Annuaire.
  r = await api('POST', `${DS}/directory`, 'cfo@x.com', { name: 'Sophie' });
  ok(r.body.directory.includes('Sophie') && (await api('POST', `${DS}/directory`, 'lecteur@x.com', { name: 'Zoé' })).status === 403, 'annuaire : ajout (edit exigé)');
  ok((await api('POST', `${DS}/directory`, 'cfo@x.com', { name: '<i>' })).body.error === 'bad_owner', 'annuaire : nom refusé');
  r = await api('DELETE', `${DS}/directory/${encodeURIComponent('Sophie')}`, 'cfo@x.com');
  ok(r.body.directory.includes('Sophie') === false && (await api('DELETE', `${DS}/directory/Sophie`, 'cfo@x.com')).status === 404, 'annuaire : retrait, puis 404');
  await reload();
  ok(by(A).owner === 'David', 'retirer un nom de l\'annuaire ne retire pas les lignes déjà confiées');
  await db.query('DELETE FROM finance_owner_directory');
  await DA.ensureSchema(pool);
  ok((await db.query('SELECT COUNT(*) AS c FROM finance_owner_directory')).rows[0].c == 0, 'annuaire vidé par la CFO : jamais re-semé au redémarrage');

  // ---------------------------------------------------------------- progression
  const PR = '/api/finance/progress';
  ok((await api('GET', PR, 'lecteur@x.com')).status === 403 && (await api('GET', PR, 'analyste@x.com')).status === 403 && (await api('GET', PR, 'approver@x.com')).status === 403, 'progression : finance:progress exigée');
  ok((await api('GET', PR, 'cfo@x.com', null, { 'x-test-demo': '1' })).status === 403, 'progression : mode démo bloqué');

  // Tables des autres lots absentes : jamais une erreur, des points « à vérifier ».
  const modules = { kpi: require('../kpi'), forecasts: require('../forecasts'), managers: require('../managers') };
  for (const t of ['finance_kpi_budget', 'finance_kpi_sync_status', 'finance_gl_monthly', 'finance_fc_docs', 'finance_deferred_contracts', 'finance_amort_lots']) await db.query(`DROP TABLE IF EXISTS ${t}`);
  let p = await api('GET', PR, 'prog@x.com');
  ok(p.status === 200 && !p.body.empty, 'tables des autres lots absentes : 200, pas une erreur');
  const item = (id) => p.body.items.find((x) => x.id === id);
  for (const idn of ['kpi_budget', 'billing_sync', 'books_connected', 'gl_actuals', 'forecasts', 'managers_deferred', 'managers_amort']) {
    ok(item(idn).state === 'warn' && item(idn).detail.code === 'not_initialized', `table absente : « ${idn} » à vérifier (module pas encore initialisé)`);
  }
  ok(p.body.ready === false, 'tables absentes : pas prêt');
  ok(JSON.stringify(p.body.items.map((x) => x.id)) === JSON.stringify(C.ITEM_DEFS.map((d) => d.id)), 'tous les points, dans l\'ordre de la liste');
  ok(p.body.items.every((x) => x.labelKey === `finance.progress.items.${x.id}` && ['done', 'todo', 'warn', 'blocked'].includes(x.state)), 'forme de chaque point : labelKey, état');
  ok(leak(p.body) === null, 'aucun nom ni salaire dans la progression');

  await modules.kpi.ensureSchema(pool); await modules.forecasts.ensureSchema(pool); await modules.managers.ensureSchema(pool);
  p = await api('GET', PR, 'prog@x.com');
  const weights = (items) => {
    let w = 0, got = 0;
    for (const x of items) { const wt = x.required ? 2 : 1; w += wt; got += wt * (x.state === 'done' ? 1 : x.total > 0 ? Math.min(1, x.done / x.total) : 0); }
    return Math.round((got / w) * 100);
  };
  ok(item('roster').state === 'done' && item('roster').detail.employees === 73 && item('roster').detail.contractors === 28, 'effectif importé : 73 employés, 28 contractuels (comptes seulement)');
  ok(item('opex_base').state === 'done' && item('opex_base').detail.lines > 20, 'base OPEX importée');
  ok(item('payroll_settings').state === 'todo' && item('kpi_budget').state === 'todo' && item('kpi_budget').total === 12 && item('kpi_budget').detail.missing === 12, 'paie non confirmée ; budget KPI : 12 mois sans budget');
  ok(item('billing_sync').state === 'todo' && item('books_connected').state === 'todo' && item('gl_actuals').state === 'todo', 'rien synchronisé : à faire');
  ok(item('budget_cluster').state === 'todo' && item('budget_cluster').detail.code === 'draft' && item('budget_departments').detail.code === 'draft', 'budgets Cluster / Xperio / départements : brouillons');
  ok(item('drivers_cogs').state === 'done' && item('drivers_cogs').done === 22, 'drivers de COGS approuvés : 22/22');
  ok(item('drivers_revenue').state === 'todo' && item('drivers_revenue').total === 30, 'drivers de revenus : à faire');
  ok(item('owners').state === 'done' && item('owners').detail.missing === 0, 'responsables : tous confirmés');
  ok(item('drivers_stale').state === 'warn' && item('drivers_stale').detail.stale >= 1, 'périmés signalés (intAdds, gaRent)');
  ok(item('final_approval').state === 'todo' && item('final_approval').detail.code === 'not_ready', 'approbation finale : pas prête');
  ok(p.body.percent === weights(p.body.items) && p.body.percent > 0 && p.body.percent < 100, `pourcentage = pondération documentée (${p.body.percent} %)`);
  ok(p.body.weighting.required === 2 && p.body.weighting.optional === 1, 'pondération exposée');
  ok(p.body.summary.groups.revenue.total === 30 && p.body.summary.total === L.length, 'comptes des drivers dans la réponse');
  let lastPct = p.body.percent;

  // Zoho : Books à reconnecter = bloqué (avec la raison), Billing synchronisé = fait.
  await db.query("INSERT INTO finance_kpi_sync_status (source, state, last_try_at, last_ok_at, last_error) VALUES ('books', 'reconnect', NOW(), NULL, 'scope')");
  await db.query("INSERT INTO finance_kpi_sync_status (source, state, last_try_at, last_ok_at) VALUES ('zoho', 'ok', NOW(), NOW())");
  p = await api('GET', PR, 'prog@x.com');
  ok(item('books_connected').state === 'blocked' && item('books_connected').detail.code === 'reconnect', 'Zoho Books à reconnecter : « blocked » avec l\'explication');
  ok(item('gl_actuals').state === 'blocked' && item('gl_actuals').detail.code === 'no_actuals_blocked', 'pas de réels parce que Books est bloqué : « blocked »');
  ok(item('billing_sync').state === 'done' && item('billing_sync').detail.at, 'Zoho Billing synchronisé : fait, avec la date');
  ok(p.body.percent > lastPct, 'le pourcentage monte avec Billing'); lastPct = p.body.percent;
  await db.query("UPDATE finance_kpi_sync_status SET state = 'ok', last_ok_at = NOW() WHERE source = 'books'");
  await db.query("INSERT INTO finance_gl_monthly (month, line_key, source, amount) VALUES ('2026-08-01', 'recurringRevenue', 'books', 100), ('2026-09-01', 'recurringRevenue', 'books', 100), ('2026-09-01', 'sellingExpense', 'manual', 5)");
  p = await api('GET', PR, 'prog@x.com');
  ok(item('books_connected').state === 'done' && item('gl_actuals').state === 'done' && item('gl_actuals').detail.months === 2, 'réels du grand livre présents : 2 mois (la source « manual » ne compte pas)');

  // Drivers de revenus, OPEX : tout approuver, puis le reste des points obligatoires.
  ok(item('opex_lines').state === 'todo', 'OPEX pas encore tout approuvé');
  await reload();
  r = await post('approve', 'cfo@x.com', { keys: L.filter((l) => l.state !== 'approved').map((l) => l.key) });
  ok(r.status === 200 && r.body.summary.approved === L.length, 'tous les drivers et lignes OPEX approuvés');
  p = await api('GET', PR, 'prog@x.com');
  ok(item('drivers_revenue').state === 'done' && item('opex_lines').state === 'done' && item('drivers_stale').state === 'done', 'les trois points de lignes + périmés : faits');
  ok(p.body.ready === false && p.body.requiredDone < p.body.requiredTotal, 'prêt seulement quand TOUT l\'obligatoire est fait (paie, KPI, budgets restent)');
  ok((await api('PUT', `/api/finance/budgets/${id}/state/payroll`, 'cfo@x.com', { data: { burden: 18, raise: 2, raiseMo: 6 }, version: 0 })).status === 200, 'réglages de paie enregistrés');
  p = await api('GET', PR, 'prog@x.com');
  ok(item('payroll_settings').state === 'done' && p.body.ready === false, 'paie confirmée ; toujours pas prêt');
  for (let m = 1; m <= 12; m++) await db.query(`INSERT INTO finance_kpi_budget (month, kpi_key, value) VALUES ('2027-${String(m).padStart(2, '0')}-01', 'canNew', 1)`);
  await db.query("INSERT INTO finance_kpi_budget (month, kpi_key, value) VALUES ('2027-01-01', 'churn', 1), ('2026-12-01', 'canNew', 1)");
  p = await api('GET', PR, 'prog@x.com');
  ok(item('kpi_budget').state === 'done' && item('kpi_budget').done === 12, 'budget KPI saisi : 12 mois sur 12 (un mois hors 2027 ne compte pas)');
  ok(p.body.ready === false, 'les trois budgets d\'entité restent à approuver : pas prêt');
  await db.query("UPDATE finance_budgets SET status = 'approved' WHERE entity IN ('cluster', 'xperio')");
  p = await api('GET', PR, 'prog@x.com');
  ok(item('budget_cluster').state === 'done' && item('budget_xperio').state === 'done' && item('budget_departments').state === 'todo' && p.body.ready === false, 'un seul budget d\'entité manque : pas prêt');
  await db.query("UPDATE finance_budgets SET status = 'approved' WHERE entity = 'departments'");
  p = await api('GET', PR, 'prog@x.com');
  ok(p.body.ready === true && p.body.requiredDone === p.body.requiredTotal, 'tout l\'obligatoire fait : ready = true');
  ok(item('final_approval').state === 'todo' && item('final_approval').detail.code === 'ready_to_approve', 'approbation finale : prête à être faite');
  ok(p.body.percent > lastPct && p.body.percent < 100, `le pourcentage n'atteint pas 100 % avant l'approbation finale (${p.body.percent} %)`); lastPct = p.body.percent;
  ok(p.body.percent === weights(p.body.items), 'pourcentage = pondération documentée, recalculé à la main');

  // « prêt » retombe si une approbation est rouverte.
  await post('reopen', 'cfo@x.com', { keys: [A], reason: 'Hypothèse remise en question' });
  p = await api('GET', PR, 'prog@x.com');
  ok(p.body.ready === false && item('drivers_revenue').state === 'todo' && item('drivers_revenue').done === 29, 'un driver rouvert : plus prêt (29/30)');
  await post('approve', 'cfo@x.com', { keys: [A] });
  ok((await api('POST', `/api/finance/budgets/${id}/approve`, 'cfo@x.com')).status === 200, 'approbation finale du budget consolidé');
  p = await api('GET', PR, 'prog@x.com');
  ok(item('final_approval').state === 'done' && p.body.ready === true && p.body.percent > lastPct, 'approbation finale : fait, pourcentage en hausse');
  ok(p.body.caps && p.body.caps.canApprove === false && (await api('GET', PR, 'cfo@x.com')).body.caps.canApprove === true, 'capacités rendues par le serveur');
  ok(leak(p.body) === null, 'aucun nom ni salaire dans la progression finale');
  ok(item('drivers_revenue').link === '/finance/revenue-drivers' && item('opex_lines').link === '/finance/opex' && item('roster').link === '/finance/payroll', 'chaque point a son lien');

  server.close();
  console.log(`✅ finance driver approvals : ${n} vérifications`);
})().catch((e) => { console.error('❌', e.stack || e.message); process.exit(1); });
