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
      weak       BOOLEAN      DEFAULT false,
      src        VARCHAR(60)  NOT NULL,
      note       TEXT         DEFAULT '',
      updated_by VARCHAR(255),
      updated_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_icplus_rates_key ON icplus_rates(table_name, cat)`);

  // Amorce unique : seulement à la toute première création de la table.
  if (!existed) {
    for (const name of TABLE_NAMES) {
      for (const e of SEED[name] || []) {
        await pool.query(
          `INSERT INTO icplus_rates (table_name, cat, rate, weak, src, updated_by)
           VALUES ($1,$2,$3,$4,$5,'seed') ON CONFLICT (table_name, cat) DO NOTHING`,
          [name, e.cat, e.rate, !!e.weak, e.src || 'statement_obs']
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
  const { rows } = await pool.query(`SELECT table_name, cat, rate, weak, src, note FROM icplus_rates ORDER BY table_name, cat`);
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

  const before = await pool.query(`SELECT cat, rate, src, weak FROM icplus_rates WHERE table_name = $1`, [tableName]);
  const beforeMap = new Map(before.rows.map((r) => [r.cat, r]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM icplus_rates WHERE table_name = $1`, [tableName]);
    for (const e of list) {
      await client.query(
        `INSERT INTO icplus_rates (table_name, cat, rate, weak, src, note, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tableName, String(e.cat).trim(), Number(e.rate), !!e.weak, e.src, String(e.note || '').slice(0, 500), actor || 'inconnu']
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
      if (!old) changes.push(`+ ${e.cat} = ${fmtPct(e.rate)} (${e.src})`);
      else if (Number(old.rate) !== Number(e.rate)) changes.push(`~ ${e.cat} : ${fmtPct(old.rate)} → ${fmtPct(e.rate)}`);
      beforeMap.delete(String(e.cat).trim());
    }
    for (const [cat, old] of beforeMap) changes.push(`− ${cat} (était ${fmtPct(old.rate)})`);

    if (changes.length) {
      await logActivity('icplus_rates', tableName, 'rates_updated',
        `Taux de référence « ${tableName} » : ${changes.length} changement(s). ${changes.join(' ; ')}`,
        actor, { metadata: { table: tableName, changes, count: list.length } });
    }
  }

  return { ok: true, count: list.length };
}

// Virgule décimale : le reste de la note est en français.
const fmtPct = (v) => `${(Number(v) * 100).toFixed(4).replace('.', ',')} %`;

async function listAll(pool) {
  const { rows } = await pool.query(
    `SELECT table_name, cat, rate, weak, src, note, updated_by, updated_at
       FROM icplus_rates ORDER BY table_name, cat`
  );
  return rows.map((r) => ({ ...r, rate: Number(r.rate) }));
}

module.exports = {
  TABLE_NAMES, SEED, MAX_RATE, MIN_RATE,
  init, load, listAll, replaceTable, validate, applyRows, ensureSchema,
};
