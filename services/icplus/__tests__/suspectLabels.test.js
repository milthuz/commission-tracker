// Le catalogue des faux frais réseau.
//
// ⚠️ SUSPECT est une ACCUSATION imprimée sur un document remis à un client. Elle ne dit
// pas « ce frais est cher », elle dit « ce nom ne correspond à aucun frais de réseau ».
// Un faux positif ici ne produit pas un bug visible : il produit une accusation fausse
// devant un marchand. Ces tests gardent donc autant ce qui EST dans le catalogue que ce
// qui en est délibérément absent.
//
// Source : « Fee Terminology Dictionary », feuille « Look-alike Fees (not network) ».
const fs = require('fs');
const path = require('path');
const C = require('../classify');
const T = require('../rateTables');
const P = require('../parsers');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };

const est = (desc, proc) => C.suspectLabel(desc, proc);

// ---------------------------------------------------------------------------
// 1. Ce que le catalogue attrape désormais.
// ---------------------------------------------------------------------------
// Chase : « TRANSACTION FEES » est imprimé dans la section « Fees and Assessments », au
// milieu des frais de réseau, et la note de bas de page du relevé admet que les frais de
// marque incluent la majoration de Paymentech.
ok('Chase — TRANSACTION FEES est attrapé', !!est('TRANSACTION FEES', 'chase'), est('TRANSACTION FEES', 'chase'));
ok('Chase — et la variante au débit aussi',
  !!est('TRANSACTION FEES 0.020148 INTERAC', 'chase'));

// Payfacto : le nom se contredit lui-même — un frais de réseau n'appartient pas au
// processeur, et aucun réseau ne facture de « processor network fee ».
ok('Payfacto — PROCESSOR NETWORK FEE est attrapé',
  !!est('VI/MC PROCESSOR NETWORK FEE', 'payfacto'), est('VI/MC PROCESSOR NETWORK FEE', 'payfacto'));

// Nuvei : des forfaits à nom de marque, sans contrepartie chez un acquéreur qui facture
// en transfert réel, alors que les évaluations en pourcentage sont déjà facturées à part.
for (const d of ['MC CYBER SECURE', 'MC DIRECT ASSESSMENT', 'MC DIRECT LICENSE']) {
  ok(`Nuvei — ${d} est attrapé`, !!est(d, 'nuvei'), est(d, 'nuvei'));
}
ok('Nuvei — VISA DIRECT ACQ ASSESSMENT l\'était déjà', !!est('VISA DIRECT ACQ ASSESSMENT', 'nuvei'));

// Global : la version anglaise du déclassement manquait à côté de « DÉCLASSEMENT ».
ok('Global — INTERCHANGE DOWNGRADE est attrapé',
  !!est('INTERCHANGE DOWNGRADE FEES', 'global'), est('INTERCHANGE DOWNGRADE FEES', 'global'));

// ---------------------------------------------------------------------------
// 2. Chaque libellé reste chez SON processeur.
//
// ⚠️ « TRANSACTION » désigne chez Moneris sa propre majoration, traitée dans son
// analyseur ; ailleurs il peut nommer un vrai frais. Un libellé qui déborde de son
// processeur reproduit exactement le problème qu'il corrige.
// ---------------------------------------------------------------------------
ok('TRANSACTION FEES ne déborde pas sur Moneris', !est('TRANSACTION FEES', 'moneris'));
ok('TRANSACTION FEES ne déborde pas sur Global', !est('TRANSACTION FEES', 'global'));
ok('PROCESSOR NETWORK FEE ne déborde pas sur Clover', !est('VI/MC PROCESSOR NETWORK FEE', 'clover'));
ok('MC CYBER SECURE ne déborde pas sur Chase', !est('MC CYBER SECURE', 'chase'));

// ---------------------------------------------------------------------------
// 3. CE QUI EST DÉLIBÉRÉMENT ABSENT — la moitié qui compte le plus.
// ---------------------------------------------------------------------------
// ⚠️ Un VRAI frais, gonflé. Le frais Mastercard existe (~0,0098 $) ; Payfacto le facture
// 0,0133 $ et sur les deux marques au lieu de MC seule. Le NOM est honnête. L'accuser par
// le nom masquerait la surfacturation réelle, que la comparaison de taux sait montrer.
ok('Payfacto — « Card Brand Network Access Fee » n\'est PAS accusé par son nom',
  !est('VI/MC CARD BRAND NETWORK ACCESS FEE', 'payfacto'),
  est('VI/MC CARD BRAND NETWORK ACCESS FEE', 'payfacto'));

// ⚠️ Un VRAI frais, mauvaise assiette. Nuvei applique l'IASF à du débit Visa entièrement
// domestique : le nom est bon, le taux est bon, c'est le VOLUME qui ne devrait pas y
// passer. Aucun libellé ne peut attraper ça.
ok('Nuvei — l\'IASF n\'est PAS accusé par son nom',
  !est('VS CA IASF MULTICURRENCY PURCHASE', 'nuvei'));

// ⚠️ Des frais de service honnêtement nommés. Négociables, oui ; déguisés en réseau, non.
// Ils appartiennent à la section des frais fixes, où ils comptent déjà dans le coût actuel.
for (const [d, p] of [['QUARTERLY DATA SECURITY', 'nuvei'], ['WEB REPORTS', 'chase'],
  ['MONTHLY ADMIN FEE', 'moneris'], ['STATEMENT FEE', 'chase']]) {
  ok(`« ${d} » reste un frais de service, pas une accusation`, !est(d, p), est(d, p));
}

// ⚠️ LA CONTRADICTION DE LA SOURCE. La feuille « Card Brand Fees » donne « MC SERVICE » et
// « MC TRANSMISSION » comme la façon dont Nuvei nomme le vrai frais de connectivité
// Mastercard — avec la réserve « (closest match) » — tandis que « Look-alike Fees » les
// range parmi six forfaits sans contrepartie. Les deux ne peuvent pas être vraies. Tant
// que la source se contredit, l'alias vers le frais réel l'emporte : une surfacturation
// ratée coûte moins cher qu'un SUSPECT infondé devant un client.
for (const d of ['MC SERVICE', 'MC TRANSMISSION']) {
  ok(`Nuvei — « ${d} » n'est pas accusé tant que la source se contredit`, !est(d, 'nuvei'), est(d, 'nuvei'));
  const r = C.classifyBrandLine({ desc: d, rate: 0, perItem: 0.009765, volume: 10000, count: 1000, total: 9.77 },
    { processor: 'nuvei' });
  ok(`Nuvei — « ${d} » est reconnu comme le frais de connectivité réel`,
    /Connectivity/i.test(r.cat || ''), r.cat);
}

// ---------------------------------------------------------------------------
// 4. Aucune accusation NOUVELLE sur les relevés réels.
//
// ⚠️ Le test qui empêche d'élargir le catalogue à l'aveugle. Les jeux d'essai de Chase et
// Payfacto sont SYNTHÉTIQUES et ne contiennent aucune de ces lignes — ces libellés n'ont
// donc jamais été confrontés à du vrai papier, et ce test ne le prouve pas. Ce qu'il
// prouve, c'est qu'ils n'accusent rien qui existe déjà.
// ---------------------------------------------------------------------------
const F = (p) => fs.readFileSync(path.join(__dirname, 'fixtures', p), 'utf8').split('\n').filter((l) => l.length);
const ATTENDU = { 'global-fr.lines.txt': 1, 'clover-fr.lines.txt': 0, 'payfacto.lines.txt': 0, 'nuvei.lines.txt': 3, 'chase.lines.txt': 0 };
for (const [f, n] of Object.entries(ATTENDU)) {
  let lines;
  try { lines = F(f); } catch { continue; }
  const sus = [].concat(...Object.values(P.parse(lines).line_audit || {})).filter((x) => x.status === C.STATUS.SUSPECT);
  ok(`${f} : ${n} SUSPECT, ni plus ni moins`, sus.length === n, sus.map((x) => x.desc));
}

// ---------------------------------------------------------------------------
// 5. Intégrité du catalogue.
// ---------------------------------------------------------------------------
const tous = Object.entries(T.SUSPECT_LABELS).flatMap(([p, l]) => l.map((s) => ({ p, s })));
ok('aucun libellé vide', tous.every((x) => String(x.s).trim().length > 0));
// Un libellé de deux caractères s'attraperait sur des dizaines de lignes légitimes.
ok('aucun libellé dangereusement court', tous.every((x) => String(x.s).trim().length >= 3),
  tous.filter((x) => String(x.s).trim().length < 3));

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
