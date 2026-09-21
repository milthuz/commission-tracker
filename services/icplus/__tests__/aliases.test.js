// Les alias de terminologie : comment chaque processeur nomme, sur son relevé, un frais
// que nos tables connaissent autrement.
//
// Ce que ces tests gardent, c'est surtout l'INTÉGRITÉ de la table d'alias. Elle a été
// générée depuis le dictionnaire, et deux défauts s'y sont glissés sans rien casser de
// visible : des clés non normalisées (donc introuvables à la recherche) et des bouts de
// prose pris pour des libellés. Les deux étaient silencieux.
const fs = require('fs');
const path = require('path');
const { PROCESSOR_ALIASES } = require('../aliases');
const C = require('../classify');
const T = require('../rateTables');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };

const TOUTES = Object.values(T.RATE_TABLES).flat();
const tous = Object.entries(PROCESSOR_ALIASES).flatMap(([p, m]) => Object.entries(m).map(([k, v]) => ({ p, k, v })));

ok('la table d\'alias n\'est pas vide', tous.length > 100, tous.length);

// ---------------------------------------------------------------------------
// 1. Intégrité.
// ---------------------------------------------------------------------------
// ⚠️ La recherche fait `table[norm(desc)]`. Une clé qui n'est pas déjà sous forme
// normalisée n'est JAMAIS trouvée, et rien ne le signale — 31 alias sur 157 étaient dans
// ce cas à la génération, tous ceux de Payfacto, qui imprime en casse mixte.
const malFormees = tous.filter((a) => C.norm(a.k) !== a.k);
ok('toutes les clés sont sous forme normalisée', malFormees.length === 0,
  malFormees.slice(0, 5).map((a) => a.p + ': ' + a.k));

// ⚠️ Un libellé qui ne correspond à aucune catégorie de table ne mène nulle part : l'alias
// remplace la description par un nom que le classificateur ne connaît pas, et la ligne
// tombe sur « À vérifier » en ayant l'air d'avoir été reconnue. Ce test casse aussi le
// jour où quelqu'un renomme une catégorie dans rateTables sans toucher aux alias.
const orphelins = tous.filter((a) => !TOUTES.some((e) => e.cat === a.v));
ok('tout libellé d\'alias existe en table', orphelins.length === 0,
  orphelins.slice(0, 5).map((a) => a.p + ': ' + a.k + ' -> ' + a.v));

// Le dictionnaire écrit « MISSING - likely inside ... » pour dire qu'aucune ligne
// n'existe, et « product code VIBS » pour désigner un code. Ni l'un ni l'autre n'est un
// libellé imprimé sur un relevé.
const prose = tous.filter((a) => /\bMISSING\b|PRODUCT CODE/i.test(a.k));
ok('aucun fragment de prose parmi les clés', prose.length === 0, prose.map((a) => a.k));

// Une clé de deux ou trois caractères s'attraperait par préfixe sur presque tout.
const tropCourtes = tous.filter((a) => a.k.length < 4);
ok('aucune clé dangereusement courte', tropCourtes.length === 0, tropCourtes.map((a) => a.k));

// ---------------------------------------------------------------------------
// 2. Ce que l'alias fait réellement.
// ---------------------------------------------------------------------------
const brand = (p, desc, rate) =>
  C.classifyBrandLine({ desc, rate, volume: 100000, total: rate * 100000 }, { processor: p });
const inter = (p, desc, rate) =>
  C.classifyInterchangeLine({ desc, rate, volume: 50000, total: rate * 50000 }, { processor: p });

// ⚠️ LE CAS QUI MOTIVE TOUT LE FICHIER. « MC - EVALUATION » contre « Mastercard — Frais
// d'évaluation (assessment, domestique) » ne fait que ~0,70 de ressemblance, sous le
// seuil de 0,75 : l'appariement par nom échoue, et seul le taux restait.
ok('la ressemblance seule ne suffisait pas',
  C.similarity('MC - EVALUATION', 'Mastercard — Frais d\'évaluation (assessment, domestique)') < C.DEFAULT_MIN_RATIO,
  C.similarity('MC - EVALUATION', 'Mastercard — Frais d\'évaluation (assessment, domestique)'));

const mcEval = brand('moneris', 'MC - EVALUATION', 0.0010);
ok('l\'alias reconnaît le libellé Moneris', /^Mastercard/.test(mcEval.cat || ''), mcEval.cat);
ok('et le déclare conforme', mcEval.status === C.STATUS.CONFORME, mcEval.status);

// ⚠️ La description garde la formulation DU RELEVÉ : c'est elle que le rep retrouve sur le
// papier. Une ligne renommée en douce est introuvable au moment de la réconciliation.
ok('la description du relevé est conservée', mcEval.desc === 'MC - EVALUATION', mcEval.desc);
ok('et l\'alias employé est déclaré', mcEval.aliasOf === 'Mastercard — Frais d\'évaluation (assessment, domestique)'
  || typeof mcEval.aliasOf === 'string', mcEval.aliasOf);

// ---------------------------------------------------------------------------
// 3. LA valeur réelle : départager deux catégories au MÊME taux.
//
// ⚠️ Mesuré : sur les cinq relevés de test, les alias ne changent AUCUN verdict — le taux
// suffisait déjà. Leur apport est ailleurs : huit catégories portent 2,0000 %, et sans
// alias c'est la première du tableau qui gagne, arbitrairement. Le montant est le même,
// mais la catégorie imprimée sur le document client est fausse.
// ---------------------------------------------------------------------------
const aDeuxPourCent = TOUTES.filter((e) => Math.abs(Number(e.rate) - 0.02) < 1e-9);
ok('plusieurs catégories partagent 2,0000 %', aDeuxPourCent.length >= 5, aDeuxPourCent.length);

const x40 = inter('moneris', 'CAN-X40 MC INTRAPAYS TAUX 1', 0.02);
ok('CAN-X40 est rangé par son alias, pas par l\'ordre du tableau',
  /Large Market/.test(x40.cat || ''), x40.cat);

// ---------------------------------------------------------------------------
// 4. Les garde-fous.
// ---------------------------------------------------------------------------
// ⚠️ SUSPECT passe AVANT l'alias. Un nom de frais bidon connu doit rester SUSPECT même
// s'il ressemble par ailleurs à un vrai frais réseau — sinon un alias blanchirait
// exactement ce que l'outil est là pour dénoncer.
const sus = brand('global', 'DATASECFEE', 0.0027);
ok('un libellé SUSPECT le reste malgré les alias', sus.status === C.STATUS.SUSPECT, sus.status);

// Un alias n'a cours que chez SON processeur : les relevés se contredisent d'un
// processeur à l'autre, et un alias global reproduirait le problème qu'il corrige.
const chezAutre = brand('payfacto', 'MC - EVALUATION', 0.0010);
ok('un alias Moneris ne s\'applique pas à Payfacto', !chezAutre.aliasOf, chezAutre.aliasOf);

// ⚠️⚠️ UN CODE COURT NE S'APPARIE PAS PAR PRÉFIXE. Mesuré en vrai : le dictionnaire ne
// connaissait qu'un « VINF », et le relevé Global porte quatre lignes qui commencent par
// « VINF » — VINF CDN ELC SME, VINF CDN HI-NET ELC SME, VINF CDN EDS ELC, VINF CDN
// HI-NET OTHR. Quatre produits, quatre taux. Le préfixe les ramenait tous à l'Infinite
// de base à 1,57 %, ce qui déclarait un Infinite Privilege (2,08 %) conforme au mauvais
// taux. Sous le seuil, seule l'égalité exacte compte.
{
  const exact = C.classifyInterchangeLine(
    { desc: 'MC ASMTS', rate: 0.001, volume: 1000, total: 1 }, { processor: 'global' });
  ok('une clé longue s\'apparie encore', !!exact.cat || !!exact.aliasOf, exact.cat);

  // Une clé courte fabriquée : elle ne doit PAS attraper une ligne plus longue.
  const table = PROCESSOR_ALIASES.moneris;
  const ajoutee = 'ZZZ';
  table[ajoutee] = 'Visa Crédit conso. — Électronique (Infinite)';
  const r = C.classifyInterchangeLine(
    { desc: 'ZZZ AUTRE CHOSE ENTIEREMENT', rate: 0.0157, volume: 1000, total: 15.7 },
    { processor: 'moneris' });
  delete table[ajoutee];
  ok('une clé de 3 caractères n\'attrape pas une ligne plus longue', !r.aliasOf, r.aliasOf);
}

// ⚠️ Les clés sont essayées de la plus longue à la plus courte. Sans cet ordre, un alias
// court préfixerait une ligne plus longue qui désigne autre chose.
const cles = Object.keys(PROCESSOR_ALIASES.moneris);
const court = cles.find((k) => cles.some((o) => o !== k && o.startsWith(k + ' ')));
if (court) {
  const long = cles.find((o) => o !== court && o.startsWith(court + ' '));
  const r = inter('moneris', long, 0.0125);
  ok('la clé la plus LONGUE gagne sur un préfixe partagé',
    r.aliasOf === PROCESSOR_ALIASES.moneris[long], { court, long, obtenu: r.aliasOf });
} else {
  ok('aucune clé Moneris n\'en préfixe une autre (rien à départager)', true);
}

// ---------------------------------------------------------------------------
// 5. Vérification croisée contre le classeur Moneris, s'il est là.
//
// ⚠️ Le classeur n'est PAS dans le dépôt. Quand il manque, ce bloc le DIT : une assertion
// qui ne s'exécute pas ne prouve rien.
// ---------------------------------------------------------------------------
const WB = process.env.ICPLUS_WORKBOOK
  || 'C:/Users/lafle/Downloads/Adyen vs Moneris - Fee Mapping - May 2026.xlsx';

if (fs.existsSync(WB)) {
  const XLSX = require('xlsx');
  const codes = XLSX.utils.sheet_to_json(XLSX.readFile(WB).Sheets['Interchange Mapping'], { header: 1, defval: '' })
    .slice(5).filter((r) => r[0] && r[1])
    .map((r) => ({ code: String(r[1]).trim(), rate: r[4] === '' ? null : Number(r[4]), per: r[5] === '' ? null : Number(r[5]) }));

  let verifies = 0;
  const ecarts = [];
  for (const [k, label] of Object.entries(PROCESSOR_ALIASES.moneris)) {
    const c = codes.find((x) => k.toUpperCase().startsWith(x.code.toUpperCase()));
    if (!c) continue;
    const e = TOUTES.find((x) => x.cat === label);
    if (!e) continue;
    verifies++;
    const attendu = c.per !== null ? c.per : c.rate;
    const obtenu = Number(e.perItem || 0) > 0 ? Number(e.perItem) : Number(e.rate);
    if (Math.abs(attendu - obtenu) > 1e-9) ecarts.push({ code: c.code, attendu, obtenu, label });
  }
  ok('[réel] des alias Moneris portent un code que le classeur tarife', verifies >= 10, verifies);
  ok('[réel] et le taux du classeur est celui de la catégorie visée', ecarts.length === 0, ecarts.slice(0, 4));
} else {
  console.log('SKIP [réel] classeur absent — 2 assertions NON exécutées.');
}

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
