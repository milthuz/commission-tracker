// ---------------------------------------------------------------------------
// Lecteur de classeur « <Acquéreur A> vs <Acquéreur B> — Fee Mapping ».
//
// Déterministe : aucun modèle, aucune devinette. Le classeur est une grille, on la lit
// comme une grille. C'est le pendant de rateCardExtract.js (qui, lui, lit une carte de
// taux en PDF avec un modèle) et il rend la même forme de proposition, pour que le
// panneau de revue déjà en place l'affiche sans code neuf.
//
// ⚠️ N'ÉCRIT RIEN. Comme l'extraction PDF : il PROPOSE, l'humain tranche, et
// l'enregistrement passe par le même PUT que la saisie manuelle — donc même validation,
// même transaction, même trace.
//
// ⚠️⚠️ LA RÈGLE QUI COMPTE, et la raison d'être de ce fichier.
//
// Le classeur porte DEUX colonnes de taux par ligne : ce que l'acquéreur du relevé
// facture, et ce que l'acquéreur de référence facture. Ni l'une ni l'autre n'est un taux
// PUBLIÉ. Or ces tables servent à juger si une ligne facturée est conforme au taux publié
// — y verser un taux facturé, c'est faire bénir la surfacturation par l'outil censé la
// dénoncer. C'est exactement le bug corrigé le 2026-09-21 : 0,678 % logé comme « publié »
// alors que c'était 0,60 % × 1,13, et l'outil déclarait « Conforme » une majoration de
// 13 %.
//
// D'où la seule distinction que fait ce module :
//
//   • Les deux acquéreurs facturent LE MÊME chiffre → c'est un transfert réseau
//     authentique. Deux entreprises indépendantes n'atterrissent pas au cent près sur le
//     même nombre par hasard ; elles repassent le chiffre du réseau. Proposé COCHÉ.
//
//   • Les deux chiffres DIFFÈRENT → au moins l'un des deux ajoute sa marge, et rien dans
//     le classeur ne dit lequel ni combien. Proposé DÉCOCHÉ, les deux chiffres affichés,
//     à confronter à la carte publiée du réseau.
//
// Sur le classeur de mai 2026, ça sépare proprement : 33 lignes d'interchange identiques
// au cent près, 11 lignes de frais de réseau toutes différentes — et les écarts y sont
// précisément les ratios de majoration déjà identifiés (1,13 / 1,017 / 1,0762).
// ---------------------------------------------------------------------------
const XLSX = require('xlsx');
const {
  similarity, norm,
  DEFAULT_MIN_RATIO, DEFAULT_EPSILON, DEFAULT_PER_ITEM_EPSILON,
} = require('./classify');

const MAX_XLSX_BYTES = 15 * 1024 * 1024;

// Un taux de plus de 100 % est une colonne mal lue, pas un taux.
const MAX_RATE = 1;
const MAX_PER_ITEM = 10;
// Tolérance de comparaison entre les deux colonnes. On ne compare pas des mesures, on
// compare deux saisies décimales écrites par la même main.
const AGREE_EPS = 1e-9;

// ---------------------------------------------------------------------------
// Repérage des colonnes PAR EN-TÊTE, jamais par indice.
//
// Les deux feuilles n'ont pas la même grille : « Interchange Mapping » porte une colonne
// « Moneris Code » que « Scheme Fee Mapping » remplace par « Statement Section ». Tout
// indice codé en dur y déraperait d'une colonne, et un décalage d'une colonne met le taux
// de l'acquéreur de référence dans le champ de l'autre sans rien casser de visible.
// ---------------------------------------------------------------------------
// ⚠️ Les en-têtes changent d'un acquéreur à l'autre. Le classeur Moneris écrit « Moneris
// Description (as printed, FR) » et « English Reading » ; celui de Global écrit « Global
// Fee Name (decoded) » et « Global Row Type », et n'a AUCUNE colonne de section de relevé.
// Un motif taillé pour un seul des deux ne casse rien de visible : il laisse simplement la
// colonne non résolue, et chaque ligne ressort alors nommée « Visa » ou « Mastercard ».
// C'est ce qui est arrivé — 26 propositions toutes homonymes, dont une cochée. D'où les
// motifs élargis ci-dessous ET la garde `catUnreadable` dans buildProposal, qui est la
// vraie protection : les en-têtes du prochain acquéreur seront encore différents.
const COLUMN_PATTERNS = {
  brand:          /^card\s*brand$/i,
  code:           /\bcode\b/i,
  descA:          /as printed|fee name\s*\(|description.*\(/i,
  reading:        /english\s*reading|row\s*type/i,
  section:        /statement\s*section/i,
  rateA:          /^(?!adyen).*rate\s*%$/i,
  perItemA:       /^(?!adyen).*rate\s*\$\s*\/\s*(txn|item)$/i,
  nameB:          /adyen.*(equivalent|fee name)/i,
  rateB:          /^adyen.*rate\s*%$/i,
  perItemB:       /^adyen.*rate\s*\$\s*\/\s*(txn|item)$/i,
  confidence:     /match\s*confidence/i,
  notes:          /^notes?$/i,
  classification: /^classification$/i,
};

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i] || []).map((c) => String(c || '').trim());
    // L'en-tête est la ligne qui porte au moins trois colonnes reconnues : une ligne de
    // titre isolée en porte une au plus.
    const hits = Object.values(COLUMN_PATTERNS).filter((re) => cells.some((c) => re.test(c))).length;
    if (hits >= 3) return i;
  }
  return -1;
}

function mapColumns(headerCells) {
  const cols = {};
  (headerCells || []).forEach((raw, idx) => {
    const cell = String(raw || '').trim();
    if (!cell) return;
    for (const [key, re] of Object.entries(COLUMN_PATTERNS)) {
      if (cols[key] === undefined && re.test(cell)) { cols[key] = idx; return; }
    }
  });
  return cols;
}

// Une ligne de groupe porte un libellé en première colonne et RIEN ailleurs
// (« VISA — FRAIS INTERCHANGE VISA (statement section 2) », ou simplement « VISA »).
function isGroupHeader(row) {
  if (!row || !String(row[0] || '').trim()) return false;
  return !row.slice(1).some((c) => String(c || '').trim() !== '');
}

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const cellAt = (row, idx) => (idx === undefined ? '' : String((row || [])[idx] || '').trim());

// ---------------------------------------------------------------------------
// Aiguillage vers les huit tables.
// ---------------------------------------------------------------------------
// ⚠️ norm() rend du MAJUSCULE (il sert à apparier des libellés de relevé, qui sont
// imprimés ainsi). Le drapeau `i` n'est donc pas décoratif : sans lui, brandOf ne
// reconnaît plus rien et TOUTES les lignes tombent en « non appariée ». L'échec va du bon
// côté — aucune ligne ne part dans la mauvaise table — mais l'importateur ne rend rien.
function brandOf(text) {
  const t = norm(String(text || ''));
  if (/\bvisa\b/i.test(t)) return 'visa';
  if (/mastercard|\bmc\b/i.test(t)) return 'mc';
  if (/interac/i.test(t)) return 'interac';
  if (/amex|american express/i.test(t)) return 'amex';
  if (/discover/i.test(t)) return 'discover';
  return '';
}

// Sur la feuille d'interchange, le PRÉFIXE DU CODE porte l'information : CAN- = domestique,
// INT- = international. C'est plus fiable que le libellé, qui dit « INTERRÉGIONALE » sur
// certaines lignes internationales et rien du tout sur d'autres.
function routeInterchange(brand, code) {
  const intl = /^INT-/i.test(String(code || ''));
  if (brand === 'visa') return intl ? 'visaInternational' : 'visaDomestic';
  if (brand === 'mc') return intl ? 'mcInternational' : 'mcDomestic';
  // Les seules lignes Interac d'interchange du classeur sont les paliers Flash.
  if (brand === 'interac') return 'interacFlash';
  // Amex et Discover n'ont pas de table d'interchange dans ce modèle : Discover est replié
  // sur Visa par les relevés eux-mêmes, et Amex passe par sa propre remise. On le DIT au
  // lieu de laisser la ligne tomber en silence.
  return null;
}

// ⚠️ Le classeur Moneris porte une colonne « Statement Section » ; celui de Global n'en a
// pas. Aiguiller sur une colonne qu'un classeur sur deux ne possède pas envoyait TOUTES
// les évaluations de Global dans schemeFeesCA. On retombe donc sur le LIBELLÉ, qui existe
// toujours, et la section ne sert plus que de confirmation quand elle est là.
const ASSESSMENT_RE = /assessment|évaluation|evaluation|licen[cs]e|infrastructure/i;

function routeScheme(brand, section, desc) {
  if (brand === 'interac') return 'interacNetwork';
  const sec = String(section || '').trim();
  if (sec === '3') return 'networkFees';
  if (sec) return 'schemeFeesCA';
  // Pas de colonne de section : une évaluation ou un droit de licence est un frais de
  // réseau ; la compensation, la connexion et l'usage de données sont des frais de système.
  return ASSESSMENT_RE.test(String(desc || '')) ? 'networkFees' : 'schemeFeesCA';
}

// ---------------------------------------------------------------------------
// ⚠️⚠️ TARIF GROUPÉ — le refus le plus important de ce module.
//
// Moneris facture en IC++ : sa feuille d'interchange contient vraiment l'interchange du
// réseau, repassé tel quel. Global facture au FORFAIT : sa feuille d'interchange contient
// « Discount base — bundled interchange + acquirer markup », c'est-à-dire l'interchange ET
// la marge de Global fondus en un seul nombre, puis des lignes « IDF downgrade » qui sont
// des INCRÉMENTS ADDITIFS sur cette base, pas des taux autonomes. Le classeur le dit
// lui-même : « The Delta on these rows is NOT the true gap ».
//
// Charger ces lignes dans les tables d'interchange, c'est y inscrire la marge d'un
// acquéreur comme s'il s'agissait du taux publié d'un réseau — le bug du 2026-09-21 à
// nouveau, et à plus grande échelle. Ces lignes sont donc REFUSÉES, pas signalées : il n'y
// a aucune décision humaine à prendre, la valeur n'est pas de la nature attendue.
const BUNDLED_GROUP_RE = /bundled|discount.*(base|rate)|markup/i;
const BUNDLED_ROWTYPE_RE = /discount\s*base|\bidf\b|downgrade/i;

function bundledTariff(r) {
  if (BUNDLED_ROWTYPE_RE.test(String(r.reading || ''))) return 'rowType';
  if (BUNDLED_GROUP_RE.test(String(r.group || ''))) return 'group';
  return null;
}

// ---------------------------------------------------------------------------
function readSheet(wb, sheetName, kind) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const hi = findHeaderRow(rows);
  if (hi < 0) return { sheet: sheetName, kind, error: 'header_not_found', rows: [] };
  const cols = mapColumns(rows[hi]);

  const out = [];
  let group = '';
  for (const row of rows.slice(hi + 1)) {
    if (isGroupHeader(row)) { group = String(row[0]).trim(); continue; }
    const brandCell = cellAt(row, cols.brand);
    const descCell = cellAt(row, cols.descA);
    // ⚠️ La feuille des majorations n'a PAS de colonne « Card Brand » : exiger la marque y
    // sautait chaque ligne et rendait la classification vide en silence. On accepte donc
    // une ligne identifiée par sa seule description — et la ligne de total finale
    // (« Total Moneris own charges ») tombe d'elle-même, n'ayant ni l'une ni l'autre.
    if (!brandCell && !descCell) continue;

    out.push({
      group,
      brandCell,
      code: cellAt(row, cols.code),
      desc: descCell,
      reading: cellAt(row, cols.reading),
      section: cellAt(row, cols.section),
      rateA: num((row || [])[cols.rateA]),
      perItemA: num((row || [])[cols.perItemA]),
      nameB: cellAt(row, cols.nameB),
      rateB: num((row || [])[cols.rateB]),
      perItemB: num((row || [])[cols.perItemB]),
      confidence: cellAt(row, cols.confidence),
      note: cellAt(row, cols.notes),
      classification: cellAt(row, cols.classification),
    });
  }
  return { sheet: sheetName, kind, cols, rows: out };
}

// ---------------------------------------------------------------------------
// Heurt avec ce qui est DÉJÀ en table.
//
// ⚠️ Première version : « est-ce que ce libellé ressemble à un libellé existant ? », au
// seuil du classificateur. Mesuré contre le vrai classeur, inutilisable dans les deux
// sens. Au seuil de 0,75 rien ne se déclenche (« VISA - ÉVALUATION » contre « Visa —
// Frais d'évaluation (assessment, domestique) » ne fait que 0,657). En le baissant, les
// appariements deviennent FAUX : l'évaluation INTERNATIONALE pointe la domestique (0,532),
// « DISCOVER - ÉVALUATION » pointe une entrée VISA (0,560), « MC - COMMANDES POSTALES »
// pointe l'évaluation MC (0,375). Annoncer « vous avez déjà ça à 0,09 % » en désignant une
// entrée sans rapport est pire que de se taire.
//
// La question posée ici n'est donc plus « est-ce la même chose ? » — jugement que la
// machine rend mal — mais une question mécanique et vérifiable :
//
//       est-ce que charger cette ligne rendrait le classificateur AMBIGU ?
//
// Deux façons, et ce sont exactement les deux voies d'appariement du classificateur :
//   • même taux à son epsilon près sous un autre nom → matchByRate aurait deux réponses ;
//   • nom assez proche pour son propre seuil        → matchByName aurait deux réponses.
//
// Le reste — « est-ce la même catégorie sous une autre plume ? » — est rendu comme
// CONTEXTE (`nearest`), présenté pour ce qu'il est : l'entrée existante la plus proche,
// avec son taux de ressemblance, à côté du chiffre proposé. C'est à l'humain de trancher,
// et il lui faut le voisinage, pas une affirmation.
// ---------------------------------------------------------------------------
function nearestExisting(cat, existing) {
  const brand = brandOf(cat);
  let best = null;
  let bestRatio = 0;
  for (const e of existing || []) {
    // Une entrée d'une AUTRE marque n'est jamais le voisin utile : la comparer ne fait
    // qu'inventer un rapprochement (Discover contre Visa, mesuré à 0,560).
    if (brand && brandOf(e.cat) && brandOf(e.cat) !== brand) continue;
    const r = similarity(cat, e.cat);
    if (r > bestRatio) { bestRatio = r; best = e; }
  }
  return best ? { entry: best, ratio: bestRatio } : null;
}

// Les collisions, elles, sont affirmables : elles ne dépendent d'aucun jugement sur le
// sens des mots, seulement des seuils que le classificateur applique réellement.
function collisions(cat, rate, perItem, existing) {
  const out = [];
  const brand = brandOf(cat);
  for (const e of existing || []) {
    // ⚠️ Même garde de marque que le classificateur. Sans elle, « MC - COMMANDES POSTALES »
    // à 0,0169 % se déclare en heurt avec « Visa — ARQ » à 0,0200 % (l'écart tient dans
    // l'epsilon) : un heurt que le classificateur ne connaîtra jamais, donc une fausse
    // alarme posée sur la seule ligne du classeur où l'acquéreur du relevé est le MOINS cher.
    if (brand && brandOf(e.cat) && brandOf(e.cat) !== brand) continue;
    const sameName = similarity(cat, e.cat) >= DEFAULT_MIN_RATIO;
    const eRate = Number(e.rate || 0);
    const ePer = Number(e.perItem || 0);
    const sameRate = rate > 0 && eRate > 0 && Math.abs(rate - eRate) <= DEFAULT_EPSILON;
    const samePer = perItem > 0 && ePer > 0 && Math.abs(perItem - ePer) <= DEFAULT_PER_ITEM_EPSILON;
    if (sameName && Math.abs(eRate - rate) < 1e-9 && Math.abs(ePer - perItem) < 1e-9) {
      out.push({ kind: 'alreadyPresent', entry: e });
    } else if (sameName) {
      out.push({ kind: 'nameCollision', entry: e });
    } else if (sameRate || samePer) {
      out.push({ kind: 'valueCollision', entry: e });
    }
  }
  return out;
}

function fmtVal(rate, perItem) {
  if (perItem) return Number(perItem).toFixed(6).replace('.', ',') + ' $/trans.';
  return (Number(rate) * 100).toFixed(4).replace('.', ',') + ' %';
}

// ---------------------------------------------------------------------------
function buildProposal(r, kind, tables, labels) {
  const brand = brandOf(r.brandCell) || brandOf(r.group);
  const bundled = kind === 'interchange' ? bundledTariff(r) : null;
  const table = bundled ? null
    : kind === 'interchange' ? routeInterchange(brand, r.code)
      : routeScheme(brand, r.section, r.desc);

  const flags = [];
  if (bundled) flags.push('bundledTariff');
  const agreeRate = r.rateA !== null && r.rateB !== null && Math.abs(r.rateA - r.rateB) <= AGREE_EPS;
  const agreePer = r.perItemA !== null && r.perItemB !== null && Math.abs(r.perItemA - r.perItemB) <= AGREE_EPS;
  const onlyA = (r.rateA !== null && r.rateB === null) && (r.perItemA === null || r.perItemB === null);

  // La valeur proposée est CELLE SUR LAQUELLE LES DEUX S'ACCORDENT, jamais une moyenne ni
  // « la plus basse » : sur ce classeur une ligne (les commandes postales Mastercard) a
  // l'acquéreur du relevé MOINS cher que l'autre, donc aucune règle de direction ne tient.
  const rate = r.rateA !== null ? r.rateA : 0;
  const perItem = r.perItemA !== null ? r.perItemA : 0;

  if (!table) flags.push('noTargetTable');
  if (rate === 0 && perItem === 0) flags.push('noValue');
  if (rate > MAX_RATE) flags.push('looksLikePercent');
  if (rate < 0 || perItem < 0) flags.push('negative');
  if (perItem > MAX_PER_ITEM) flags.push('perItemTooLarge');
  if (rate > 0 && perItem > 0) flags.push('bothRateAndPerItem');
  if (!agreeRate && !agreePer) flags.push(onlyA ? 'singleSource' : 'acquirersDisagree');

  // Le libellé stocké garde la formulation du relevé ET la lecture anglaise : c'est la
  // formulation du relevé que le classificateur devra reconnaître demain.
  const cat = [r.desc, r.reading && r.reading !== r.desc ? '(' + r.reading + ')' : '']
    .filter(Boolean).join(' ').trim() || r.reading || r.brandCell;

  // ⚠️⚠️ LA GARDE QUI MANQUAIT, et qui vaut plus que l'élargissement des motifs de
  // colonne. Quand la colonne de description ne se résout pas, `cat` retombe sur la seule
  // marque : treize lignes toutes nommées « Visa », indiscernables, dont une proposée
  // COCHÉE. Le module ne refusait rien — il rendait du plausible et faux, ce qui est pire
  // qu'une erreur franche.
  //
  // Les en-têtes du prochain acquéreur seront encore différents des deux connus. Élargir
  // les motifs traite les cas d'aujourd'hui ; cette garde traite ceux de demain.
  const catIsBrandOnly = !!r.brandCell && cat.trim().toLowerCase() === r.brandCell.trim().toLowerCase();
  if (!cat.trim() || catIsBrandOnly) flags.push('catUnreadable');

  const existing = (table && tables && tables[table]) || [];
  const hits = collisions(cat, rate, perItem, existing);
  for (const h of hits) if (!flags.includes(h.kind)) flags.push(h.kind);

  const near = nearestExisting(cat, existing);
  const asRow = (e) => ({ cat: e.cat, printedAs: fmtVal(Number(e.rate || 0), Number(e.perItem || 0)), src: e.src });

  return {
    table,
    cat,
    rate: Number.isFinite(rate) ? rate : 0,
    perItem: Number.isFinite(perItem) ? perItem : 0,
    printedAs: fmtVal(rate, perItem),
    code: r.code || null,
    group: r.group,
    // Les deux observations restent VISIBLES sur la proposition : c'est ce qui permet à
    // l'humain de trancher sans rouvrir le classeur.
    observed: {
      a: r.rateA !== null || r.perItemA !== null ? fmtVal(r.rateA || 0, r.perItemA || 0) : null,
      b: r.rateB !== null || r.perItemB !== null ? fmtVal(r.rateB || 0, r.perItemB || 0) : null,
    },
    labels,
    agree: agreeRate || agreePer,
    confidence: r.confidence || null,
    note: String(r.note || '').slice(0, 300),
    // Les heurts sont AFFIRMÉS ; le voisinage est seulement MONTRÉ, avec sa ressemblance,
    // pour que l'humain voie contre quoi il décide.
    collidesWith: hits.map((h) => ({ kind: h.kind, ...asRow(h.entry) })),
    nearest: near ? { ...asRow(near.entry), ratio: Number(near.ratio.toFixed(3)) } : null,
    flags,
    // ⚠️ Décoché dès qu'il y a le moindre doute, et décoché d'office hors interchange. Un
    // taux faux ne produit pas une erreur visible : il produit un « Conforme » tranquille
    // sur un document remis à un client.
    accept: flags.length === 0 && kind === 'interchange',
  };
}

// ---------------------------------------------------------------------------
function readWorkbook({ buffer, tables, labels }) {
  if (!buffer || !buffer.length) return { ok: false, reason: 'no_file' };
  if (buffer.length > MAX_XLSX_BYTES) return { ok: false, reason: 'too_large' };

  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    return { ok: false, reason: 'unreadable', detail: e.message };
  }

  const L = { a: (labels && labels.a) || 'Relevé', b: (labels && labels.b) || 'Référence' };

  // Les feuilles sont reconnues par leur NOM, tolérant à la casse et au nom de
  // l'acquéreur : un classeur « Adyen vs Chase » doit passer par le même chemin.
  const pick = (re) => wb.SheetNames.find((n) => re.test(n));
  const sheets = [
    { name: pick(/interchange\s*mapping/i), kind: 'interchange' },
    { name: pick(/scheme\s*fee\s*mapping/i), kind: 'scheme' },
  ].filter((s) => s.name);

  if (!sheets.length) return { ok: false, reason: 'no_known_sheet', sheetNames: wb.SheetNames };

  const proposals = {};
  const unmapped = [];
  const read = [];

  for (const s of sheets) {
    const sheet = readSheet(wb, s.name, s.kind);
    if (!sheet || sheet.error) {
      read.push({ sheet: s.name, error: (sheet && sheet.error) || 'unreadable' });
      continue;
    }
    read.push({ sheet: s.name, kind: s.kind, rows: sheet.rows.length });
    for (const r of sheet.rows) {
      const p = buildProposal(r, s.kind, tables, L);
      if (!p.table) { unmapped.push(p); continue; }
      (proposals[p.table] = proposals[p.table] || []).push(p);
    }
  }

  // La feuille des majorations n'est PAS une source de taux : c'est la classification des
  // lignes propres à l'acquéreur. On la rend pour information — elle confirme (ou
  // contredit) les libellés SUSPECT codés dans rateTables.
  const markupSheetName = pick(/markup|own charges/i);
  let classification = null;
  if (markupSheetName) {
    const sheet = readSheet(wb, markupSheetName, 'markup');
    if (sheet && !sheet.error) {
      classification = sheet.rows
        .filter((r) => r.classification)
        .map((r) => ({
          desc: r.desc || r.reading,
          reading: r.reading,
          section: r.section,
          classification: r.classification,
        }));
    }
  }

  const all = Object.values(proposals).flat();
  return {
    ok: true,
    labels: L,
    sheetsRead: read,
    proposals,
    unmapped,
    classification,
    summary: {
      total: all.length + unmapped.length,
      proposed: all.length,
      accepted: all.filter((p) => p.accept).length,
      flagged: all.filter((p) => p.flags.length).length,
      unmapped: unmapped.length,
      disagree: all.filter((p) => p.flags.includes('acquirersDisagree')).length,
      collisions: all.filter((p) => p.collidesWith.length).length,
      tables: Object.fromEntries(Object.entries(proposals).map(([k, v]) => [k, v.length])),
    },
  };
}

module.exports = {
  readWorkbook, readSheet, buildProposal, findHeaderRow, mapColumns,
  isGroupHeader, routeInterchange, routeScheme, brandOf, num, fmtVal,
  MAX_XLSX_BYTES, AGREE_EPS, nearestExisting, collisions,
};
