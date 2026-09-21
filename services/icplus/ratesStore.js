// ============================================================================
// IC+ — les tables de taux, éditables depuis le panneau Admin.
//
// POURQUOI CE MODULE EXISTE. Les taux vivaient en dur dans rateTables.js. C'était rigoureux
// (historique git, revue, suite de tests à chaque changement) mais impraticable : la personne
// qui détient les cartes de taux des réseaux n'éditera jamais un fichier JS, et le devis (§2)
// est explicite sur le fait que ces tables se périment — le changement transfrontalier de
// juillet 2026 était déjà la deuxième révision. Un mécanisme qui exige un déploiement pour
// chaque révision finit par ne pas être utilisé, et les tables vieillissent en silence.
//
// ⚠️ L'API RESTE SYNCHRONE. classify.js lit `RATE_TABLES.visaDomestic` directement, des
// milliers de fois par analyse. Passer la lecture en asynchrone aurait contaminé tout le
// classificateur. À la place les tableaux gardent leur IDENTITÉ et sont remplis SUR PLACE :
// chargés au démarrage, réécrits après chaque sauvegarde admin. Toute référence déjà prise
// par un module reste valide.
//
// ⚠️ CE QUE L'ON PERD, ET COMMENT ON COMPENSE. En base, un taux change sans revue de code.
// Chaque écriture passe donc par validate() (taux décimal borné, source obligatoire prise
// dans SOURCES) et laisse une trace dans activity_log : qui, quelle table, quel taux, avant →
// après. Un taux anonyme ou hors bornes est refusé, pas corrigé.
// ============================================================================

const rateTables = require('./rateTables');

const TABLE_NAMES = Object.keys(rateTables.RATE_TABLES);

// Les valeurs définies en code servent d'amorce au tout premier démarrage, puis de repli si
// la base est injoignable. Figées ici pour que le seed ne dépende pas de l'état courant des
// tableaux (qui, eux, sont mutés sur place).
const SEED = JSON.parse(JSON.stringify(
  Object.fromEntries(TABLE_NAMES.map((n) => [n, rateTables.RATE_TABLES[n]]))
));

// ⚠️ Bornes de validation. Un taux est un DÉCIMAL : 1,42 % s'écrit 0.0142. La confusion
// pourcentage/décimal est l'erreur n°1 sur ce genre d'écran et donne un taux 100× trop grand,
// alors on refuse tout ce qui dépasse 1 (soit 100 %) — aucun frais réseau n'approche ça.
const MAX_RATE = 1;
const MIN_RATE = 0;

// ⚠️ Certaines entrées sont un MONTANT FIXE par transaction, pas un pourcentage du volume :
// Interac Flash à 0,035 $ et 0,055 $, l'évaluation Interac à 0,015803 $, le débit Visa à
// 0,03 $. Le débit Interac est le plus gros volume des relevés québécois, donc sans ce
// champ la table la plus utile reste inchargeable.
//
// Un frais réseau par transaction se compte en cents. 10 $ laisse une marge confortable et
// attrape quand même une colonne de montants facturés saisie par erreur à cet endroit.
const MAX_PER_ITEM = 10;

async function ensureSchema(pool) {
  // ⚠️ La table existait-elle AVANT cet appel ? C'est la seule question qui permette
  // d'amorcer une fois et une seule. Tester « la table est-elle vide ? » ne marche pas : un
  // admin qui vide délibérément une table la verrait se repeupler au prochain déploiement,
  // et il n'aurait aucun moyen de faire tenir un vide voulu.
  const existed = (await pool.query(`SELECT to_regclass('public.icplus_rates') AS t`)).rows[0].t != null;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS icplus_rates (
      id         SERIAL PRIMARY KEY,
      table_name VARCHAR(40)  NOT NULL,
      cat        TEXT         NOT NULL,
      rate       NUMERIC(14,8) NOT NULL,
      per_item   NUMERIC(14,8) DEFAULT 0,
      weak       BOOLEAN      DEFAULT false,
      src        VARCHAR(60)  NOT NULL,
      note       TEXT         DEFAULT '',
      updated_by VARCHAR(255),
      updated_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_icplus_rates_key ON icplus_rates(table_name, cat)`);
  // La table existe déjà en production sans cette colonne — ajoutée après coup.
  await pool.query(`ALTER TABLE icplus_rates ADD COLUMN IF NOT EXISTS per_item NUMERIC(14,8) DEFAULT 0`);

  // Amorce unique : seulement à la toute première création de la table.
  if (!existed) {
    for (const name of TABLE_NAMES) {
      for (const e of SEED[name] || []) {
        await pool.query(
          // ⚠️ `per_item` DOIT figurer ici. L'amorce ne le portait pas : les 15 entrées en
          // dollars par transaction (Interac Flash et réseau, lignes « USD/txn ») seraient
          // parties en base à zéro, en silence, et l'écran aurait affiché « 0 » pour un
          // palier Flash à 0,035 $. Le plantage sur la contrainte NOT NULL de `rate` — une
          // entrée par transaction n'a pas de taux — est ce qui a révélé le trou.
          `INSERT INTO icplus_rates (table_name, cat, rate, per_item, weak, src, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,'seed') ON CONFLICT (table_name, cat) DO NOTHING`,
          [name, e.cat, Number(e.rate) || 0, Number(e.perItem) || 0, !!e.weak, e.src || 'statement_obs']
        );
      }
    }
    console.log('[icplus] tables de taux amorcées depuis le code');
  }
}

// Remplit les tableaux SUR PLACE, sans changer leur identité.
function applyRows(rows) {
  const byTable = Object.fromEntries(TABLE_NAMES.map((n) => [n, []]));
  for (const r of rows) {
    if (!byTable[r.table_name]) continue;
    const entry = { cat: r.cat, rate: Number(r.rate), src: r.src };
    if (Number(r.per_item) > 0) entry.perItem = Number(r.per_item);
    if (r.weak) entry.weak = true;
    if (r.note) entry.note = r.note;
    byTable[r.table_name].push(entry);
  }
  for (const name of TABLE_NAMES) {
    const target = rateTables.RATE_TABLES[name];
    target.length = 0;
    target.push(...byTable[name]);
  }
}

async function load(pool) {
  const { rows } = await pool.query(`SELECT table_name, cat, rate, per_item, weak, src, note FROM icplus_rates ORDER BY table_name, cat`);
  applyRows(rows);
  return rows.length;
}

// Démarrage : schéma + amorce + chargement. Ne fait jamais tomber le serveur — sans base, les
// tableaux gardent les valeurs du code, ce qui est exactement le repli voulu.
async function init(pool) {
  try {
    await ensureSchema(pool);
    const n = await load(pool);
    console.log(`[icplus] ${n} taux de référence chargés`);
  } catch (e) {
    console.error('[icplus] chargement des taux impossible, repli sur les valeurs du code:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Validation — refuse, ne corrige pas. Deviner sur un taux, c'est deviner sur de l'argent.
// ---------------------------------------------------------------------------
function validate(entry) {
  const errors = [];
  const cat = String(entry.cat || '').trim();
  if (!cat) errors.push({ field: 'cat', code: 'required' });
  if (cat.length > 200) errors.push({ field: 'cat', code: 'tooLong' });

  const rate = Number(entry.rate);
  if (!Number.isFinite(rate)) errors.push({ field: 'rate', code: 'notANumber' });
  else if (rate < MIN_RATE) errors.push({ field: 'rate', code: 'negative' });
  // Le message distingue ce cas des autres : c'est presque toujours un pourcentage non divisé.
  else if (rate > MAX_RATE) errors.push({ field: 'rate', code: 'looksLikePercent', value: rate });

  const perItem = entry.perItem === undefined || entry.perItem === null || entry.perItem === ''
    ? 0 : Number(entry.perItem);
  if (!Number.isFinite(perItem)) errors.push({ field: 'perItem', code: 'notANumber' });
  else if (perItem < 0) errors.push({ field: 'perItem', code: 'negative' });
  else if (perItem > MAX_PER_ITEM) errors.push({ field: 'perItem', code: 'perItemTooLarge', value: perItem });

  // ⚠️ Une entrée sans taux NI montant par transaction ne peut correspondre à rien : elle
  // encombrerait la table en donnant l'illusion qu'un palier est couvert.
  if (Number.isFinite(rate) && Number.isFinite(perItem) && rate === 0 && perItem === 0) {
    errors.push({ field: 'rate', code: 'noValue' });
  }

  if (!entry.src || !rateTables.SOURCES[entry.src]) errors.push({ field: 'src', code: 'unknownSource' });

  return errors;
}

// Remplace le contenu d'UNE table. Transactionnel : une entrée invalide et rien n'est écrit,
// plutôt qu'une table à moitié remplacée.
async function replaceTable(pool, tableName, entries, actor, logActivity) {
  if (!TABLE_NAMES.includes(tableName)) throw new Error(`table inconnue: ${tableName}`);

  const list = Array.isArray(entries) ? entries : [];
  const problems = [];
  list.forEach((e, i) => {
    const errs = validate(e);
    if (errs.length) problems.push({ index: i, cat: e.cat, errors: errs });
  });
  const seen = new Set();
  list.forEach((e, i) => {
    const k = String(e.cat || '').trim().toLowerCase();
    if (seen.has(k)) problems.push({ index: i, cat: e.cat, errors: [{ field: 'cat', code: 'duplicate' }] });
    seen.add(k);
  });
  if (problems.length) return { ok: false, problems };

  const before = await pool.query(`SELECT cat, rate, per_item, src, weak FROM icplus_rates WHERE table_name = $1`, [tableName]);
  const beforeMap = new Map(before.rows.map((r) => [r.cat, r]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM icplus_rates WHERE table_name = $1`, [tableName]);
    for (const e of list) {
      await client.query(
        `INSERT INTO icplus_rates (table_name, cat, rate, per_item, weak, src, note, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tableName, String(e.cat).trim(), Number(e.rate) || 0, Number(e.perItem) || 0,
         !!e.weak, e.src, String(e.note || '').slice(0, 500), actor || 'inconnu']
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await load(pool);

  // ⚠️ La trace remplace la revue de code qu'on perd en passant par un écran. Elle nomme les
  // taux MODIFIÉS un par un, avant → après : « 12 entrées enregistrées » ne permettrait pas
  // de retrouver qui a changé 0,0900 % en 0,1017 % six mois plus tard.
  if (typeof logActivity === 'function') {
    const changes = [];
    for (const e of list) {
      const old = beforeMap.get(String(e.cat).trim());
      // ⚠️ fmtVal et non fmtPct : une entrée en dollars par transaction consignée avec
      // fmtPct apparaît « 0,0000 % » dans le journal. La trace est ce qui permet de
      // reconstituer un changement de taux six mois plus tard — une trace fausse est pire
      // qu'absente. Et la comparaison doit porter sur les DEUX composantes, sinon une
      // modification de montant par transaction ne laisse aucune trace du tout.
      if (!old) changes.push(`+ ${e.cat} = ${fmtVal(e)} (${e.src})`);
      else if (Number(old.rate) !== Number(e.rate || 0)
        || Number(old.per_item || 0) !== Number(e.perItem || 0)) {
        changes.push(`~ ${e.cat} : ${fmtVal(old)} → ${fmtVal(e)}`);
      }
      beforeMap.delete(String(e.cat).trim());
    }
    for (const [cat, old] of beforeMap) changes.push(`− ${cat} (était ${fmtVal(old)})`);

    if (changes.length) {
      await logActivity('icplus_rates', tableName, 'rates_updated',
        `Taux de référence « ${tableName} » : ${changes.length} changement(s). ${changes.join(' ; ')}`,
        actor, { metadata: { table: tableName, changes, count: list.length } });
    }
  }

  return { ok: true, count: list.length };
}

// Virgule décimale : le reste de la note est en français. Une entrée par transaction se
// décrit en dollars — l'afficher en pourcentage donnerait « 3,5000 % » pour 0,035 $.
const fmtPct = (v) => `${(Number(v) * 100).toFixed(4).replace('.', ',')} %`;
const fmtVal = (e) => (Number(e && e.per_item) > 0 || Number(e && e.perItem) > 0
  ? `${Number(e.per_item || e.perItem).toFixed(6).replace('.', ',')} $/trans.`
  : fmtPct(e && e.rate !== undefined ? e.rate : e));

async function listAll(pool) {
  const { rows } = await pool.query(
    `SELECT table_name, cat, rate, per_item, weak, src, note, updated_by, updated_at
       FROM icplus_rates ORDER BY table_name, cat`
  );
  return rows.map((r) => ({ ...r, rate: Number(r.rate), perItem: Number(r.per_item) || 0 }));
}

module.exports = {
  TABLE_NAMES, SEED, MAX_RATE, MIN_RATE,
  init, load, listAll, replaceTable, validate, applyRows, ensureSchema,
};
