// Les tables de taux éditables depuis Admin.
//
// Testé contre un vrai Postgres en mémoire (PGlite) plutôt qu'avec un faux `pool` : ce qui
// mérite d'être vérifié ici, c'est le SQL — l'amorce unique, le remplacement transactionnel,
// l'index d'unicité. Un stub aurait confirmé que mon code s'appelle lui-même.
//
// ⚠️ PGlite est une dépendance de TEST seulement (installée sans --save). Si elle manque, la
// suite le DIT et sort en échec — elle ne se déclare pas verte sans avoir rien vérifié.
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch {
  console.log('FAIL PGlite absent — installer avec: npm install --no-save @electric-sql/pglite');
  process.exit(1);
}

const store = require('../ratesStore');
const rateTables = require('../rateTables');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };

// PGlite parle le protocole de `pg` de assez près pour ce module; il lui manque connect(),
// que replaceTable() utilise pour sa transaction.
function adapt(db) {
  return {
    query: (sql, params) => db.query(sql, params),
    connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }),
  };
}

(async () => {
  const db = new PGlite();
  const pool = adapt(db);

  // ---------------------------------------------------------------------------
  // Amorce
  // ---------------------------------------------------------------------------
  await store.ensureSchema(pool);
  const seeded = await store.listAll(pool);
  ok('la table est amorcée depuis le code', seeded.length === 6, seeded.length);
  ok('les 6 entrées amorcées sont des frais réseau',
    seeded.every((r) => r.table_name === 'networkFees'), [...new Set(seeded.map((r) => r.table_name))]);
  ok('chaque entrée amorcée porte une source', seeded.every((r) => !!r.src), seeded.filter((r) => !r.src));

  // ⚠️ L'amorce ne doit se produire QU'UNE FOIS. Une table vidée volontairement par un admin
  // ne doit pas se repeupler toute seule au prochain déploiement.
  await pool.query(`DELETE FROM icplus_rates`);
  await store.ensureSchema(pool);
  const afterWipe = await store.listAll(pool);
  ok('une table vidée volontairement ne se repeuple pas', afterWipe.length === 0, afterWipe.length);

  // ---------------------------------------------------------------------------
  // Validation — refuse, ne corrige pas
  // ---------------------------------------------------------------------------
  const errsOf = (e) => store.validate(e).map((x) => x.code);
  ok('une entrée correcte passe', errsOf({ cat: 'Visa — Test', rate: 0.0142, src: 'visa_published' }).length === 0);
  ok('libellé vide refusé', errsOf({ cat: '  ', rate: 0.01, src: 'visa_published' }).includes('required'));
  ok('taux non numérique refusé', errsOf({ cat: 'X', rate: 'beaucoup', src: 'visa_published' }).includes('notANumber'));
  ok('taux négatif refusé', errsOf({ cat: 'X', rate: -0.01, src: 'visa_published' }).includes('negative'));
  ok('source inconnue refusée', errsOf({ cat: 'X', rate: 0.01, src: 'un ami' }).includes('unknownSource'));
  ok('source absente refusée', errsOf({ cat: 'X', rate: 0.01 }).includes('unknownSource'));

  // ⚠️ LE piège de cet écran : saisir 1.42 au lieu de 0.0142. Un taux 100× trop grand est
  // refusé avec son propre code, pour que l'interface puisse le dire précisément plutôt que
  // « valeur invalide » — et surtout il n'est PAS divisé en silence.
  const pctErr = store.validate({ cat: 'X', rate: 1.42, src: 'visa_published' });
  ok('un pourcentage non divisé est refusé', pctErr.some((e) => e.code === 'looksLikePercent'), pctErr);
  ok('et il est refusé, pas corrigé', pctErr.length > 0);
  ok('0.0142 (le même taux, en décimal) passe', store.validate({ cat: 'X', rate: 0.0142, src: 'visa_published' }).length === 0);

  // ---------------------------------------------------------------------------
  // Remplacement transactionnel
  // ---------------------------------------------------------------------------
  const good = [
    { cat: 'Visa — Electronic Standard', rate: 0.0142, src: 'visa_published' },
    { cat: 'Visa — Infinite', rate: 0.0165, src: 'visa_published' },
  ];
  let logged = [];
  const logActivity = async (t, id, ev, desc, actor, extra) => { logged.push({ t, id, ev, desc, actor, extra }); };

  const w1 = await store.replaceTable(pool, 'visaDomestic', good, 'david@example.com', logActivity);
  ok('écriture acceptée', w1.ok === true && w1.count === 2, w1);
  ok('les entrées sont en base', (await store.listAll(pool)).filter((r) => r.table_name === 'visaDomestic').length === 2);

  // ⚠️ Tout ou rien : une table à moitié remplacée donnerait « Conforme » sur une moitié et
  // « À vérifier » sur l'autre, sans que personne ne sache laquelle est à jour.
  const mixed = [
    { cat: 'Visa — Bonne', rate: 0.01, src: 'visa_published' },
    { cat: 'Visa — Mauvaise', rate: 42, src: 'visa_published' },
  ];
  const w2 = await store.replaceTable(pool, 'visaDomestic', mixed, 'david@example.com', logActivity);
  ok('une entrée invalide fait échouer tout le lot', w2.ok === false, w2);
  ok('le problème est localisé', w2.problems[0].cat === 'Visa — Mauvaise', w2.problems);
  const still = (await store.listAll(pool)).filter((r) => r.table_name === 'visaDomestic');
  ok('et RIEN n\'a été écrit — l\'ancien contenu est intact', still.length === 2 && still.some((r) => r.cat === 'Visa — Infinite'),
    still.map((r) => r.cat));

  // Doublons refusés : deux fois le même libellé rendrait le second inatteignable.
  const dup = [
    { cat: 'Visa — Même', rate: 0.01, src: 'visa_published' },
    { cat: 'visa — même', rate: 0.02, src: 'visa_published' },
  ];
  const w3 = await store.replaceTable(pool, 'visaDomestic', dup, 'x', logActivity);
  ok('libellés en double refusés (insensible à la casse)', w3.ok === false && w3.problems.some((p) => p.errors.some((e) => e.code === 'duplicate')), w3.problems);

  ok('table inconnue rejetée', await store.replaceTable(pool, 'inventee', [], 'x', logActivity).then(() => false).catch(() => true));

  // ---------------------------------------------------------------------------
  // ⚠️ Les tableaux en mémoire sont remplis SUR PLACE : classify.js garde une référence
  // directe sur eux, donc leur IDENTITÉ doit survivre au rechargement.
  // ---------------------------------------------------------------------------
  const ref = rateTables.RATE_TABLES.visaDomestic;
  await store.load(pool);
  ok('le tableau est le MÊME objet après rechargement', rateTables.RATE_TABLES.visaDomestic === ref);
  ok('et il contient les taux de la base', ref.length === 2 && ref.some((e) => e.cat === 'Visa — Infinite'), ref.map((e) => e.cat));

  // Effet de bout en bout : avec la table remplie, le classificateur reconnaît un taux qu'il
  // ne pouvait pas reconnaître avant.
  const C = require('../classify');
  const hit = C.matchByRate(0.0165, rateTables.RATE_TABLES.visaDomestic, undefined, 'VISA INFINITE');
  ok('un taux chargé depuis la base est maintenant reconnu', !!hit && /Infinite/.test(hit.cat), hit);

  // ---------------------------------------------------------------------------
  // Trace — elle remplace la revue de code qu'on perd en passant par un écran.
  // ---------------------------------------------------------------------------
  logged = [];
  await store.replaceTable(pool, 'visaDomestic', [
    { cat: 'Visa — Electronic Standard', rate: 0.0150, src: 'visa_published' },  // modifié
    { cat: 'Visa — Nouveau', rate: 0.02, src: 'visa_published' },                // ajouté
  ], 'david@example.com', logActivity);

  ok('un changement est journalisé', logged.length === 1, logged.length);
  const desc = logged[0] ? logged[0].desc : '';
  ok('le journal nomme la table', /visaDomestic/.test(desc), desc);
  // ⚠️ « 12 entrées enregistrées » ne permettrait pas de retrouver qui a changé 0,0900 % en
  // 0,1017 % six mois plus tard. Le avant → après doit y être, taux par taux.
  ok('le journal donne le avant → après', /1,4200 % → 1,5000 %/.test(desc), desc);
  ok('le journal note l\'ajout', /\+ Visa — Nouveau/.test(desc), desc);
  ok('le journal note le retrait', /− Visa — Infinite/.test(desc), desc);
  ok('le journal nomme l\'auteur', logged[0] && logged[0].actor === 'david@example.com', logged[0] && logged[0].actor);

  // Une écriture sans changement réel ne pollue pas le journal.
  logged = [];
  await store.replaceTable(pool, 'visaDomestic', [
    { cat: 'Visa — Electronic Standard', rate: 0.0150, src: 'visa_published' },
    { cat: 'Visa — Nouveau', rate: 0.02, src: 'visa_published' },
  ], 'david@example.com', logActivity);
  ok('réenregistrer sans changement ne journalise rien', logged.length === 0, logged.length);

  await db.close();
  console.log(fail ? `\n${fail} FAILING` : '\nall green');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
