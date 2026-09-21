// Importateur de classeur « <Acquéreur A> vs <Acquéreur B> — Fee Mapping ».
//
// Le classeur qui a servi à écrire ce module N'EST PAS dans le dépôt, et ne doit pas y
// entrer : sa feuille des majorations porte les volumes réels d'un marchand identifiable
// (« 99 713,37 $ / 1 783 items »). Les cas sont donc CONSTRUITS ici, en clair, ce qui a
// l'avantage de rendre chaque piège lisible. Un bloc final rejoue le vrai classeur s'il
// se trouve sur la machine — et dit bruyamment qu'il a été SAUTÉ sinon, pour qu'une suite
// verte ne puisse pas vouloir dire « rien n'a été vérifié ».
const fs = require('fs');
const XLSX = require('xlsx');
const X = require('../rateCardExcel');
const T = require('../rateTables');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };

const LABELS = { a: 'Relevé', b: 'Référence' };

// ---------------------------------------------------------------------------
// Construction d'un classeur en mémoire. Les deux feuilles ont DES GRILLES
// DIFFÉRENTES — c'est le piège principal : « Interchange Mapping » porte une colonne de
// code là où « Scheme Fee Mapping » porte une section de relevé, donc tout indice codé en
// dur déraperait d'une colonne et logerait le taux de la référence dans le champ du relevé.
// ---------------------------------------------------------------------------
const IC_HEADER = ['Card Brand', 'Moneris Code', 'Moneris Description (as printed, FR)', 'English Reading',
  'Moneris Rate %', 'Moneris Rate $/txn', 'Adyen Equivalent Fee Name', 'Adyen Rate %', 'Adyen Rate $/txn',
  'Delta % (Mon − Adyen)', 'Delta $/txn', 'Match Confidence', 'Notes'];

const SF_HEADER = ['Card Brand', 'Moneris Description (as printed, FR)', 'English Reading', 'Statement Section',
  'Moneris Rate %', 'Moneris Rate $/txn', 'Adyen Equivalent Fee Name', 'Adyen Rate %', 'Adyen Rate $/txn',
  'Delta % (Mon − Adyen)', 'Delta $/txn', 'Match Confidence', 'Notes'];

function icRow(brand, code, desc, reading, ratA, perA, ratB, perB, conf) {
  return [brand, code, desc, reading, ratA, perA, 'nom de référence', ratB, perB, '', '', conf || 'High', ''];
}
function sfRow(brand, desc, reading, section, ratA, perA, ratB, perB) {
  return [brand, desc, reading, section, ratA, perA, 'nom de référence', ratB, perB, '', '', 'High', ''];
}

function build(icRows, sfRows, markupRows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['INTERCHANGE MAPPING — titre de la feuille'], ['sous-titre'], [''],
    IC_HEADER, ...(icRows || []),
  ]), 'Interchange Mapping');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['SCHEME FEE MAPPING — titre'], [''],
    SF_HEADER, ...(sfRows || []),
  ]), 'Scheme Fee Mapping');
  if (markupRows) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['MONERIS OWN CHARGES'], [''],
      ['Statement Section', 'Moneris Description (as printed, FR)', 'English Reading', 'Rate %',
        'Rate $/item', 'Basis', 'Fee Amount', 'Classification', 'Notes'],
      ...markupRows,
    ]), 'Moneris Markup & Suspect');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const read = (buf, tables) => X.readWorkbook({ buffer: buf, tables: tables || T.RATE_TABLES, labels: LABELS });
const flat = (out) => Object.values(out.proposals || {}).flat();
const find = (out, frag) => flat(out).find((p) => p.cat.includes(frag));

// ---------------------------------------------------------------------------
// 1. Aiguillage : le préfixe du code décide du domestique et de l'international.
// ---------------------------------------------------------------------------
{
  const out = read(build([
    ['VISA — FRAIS INTERCHANGE VISA (statement section 2)'],
    icRow('Visa', 'CAN-CE01', 'PERSONNELLE-ÉLECTR', 'Consumer electronic', 0.0125, '', 0.0125, ''),
    icRow('Visa', 'INT-C947', 'PREMIER INTERRÉGIONALE', 'Interregional premier', 0.0185, '', 0.0185, ''),
    ['MASTERCARD — FRAIS INTERCHANGE'],
    icRow('Mastercard', 'CAN-CBC', 'CONSOMMATEUR INTÉRIEUR', 'Domestic consumer', 0.0092, '', 0.0092, ''),
    icRow('Mastercard', 'INT-CYD', 'TARIF II CONSO. INT.', 'Interregional tier II', 0.0110, '', 0.0110, ''),
    ['INTERAC — FRAIS INTERCHANGE'],
    icRow('Interac', 'CAN-ZTI3', 'FLASH STAND NIVEAU 3', 'Flash standard tier 3', '', 0.035, '', 0.035),
    ['DISCOVER — FRAIS INTERCHANGE'],
    icRow('Discover', 'INT-C835', 'ÉLECTR INTERNATIONALE', 'International electronic', 0.0120, '', 0.0120, ''),
  ], []));

  ok('lit les deux feuilles', out.ok === true, out.reason);
  ok('Visa CAN- va au domestique', !!(out.proposals.visaDomestic || []).length, Object.keys(out.proposals));
  ok('Visa INT- va à l\'international', !!(out.proposals.visaInternational || []).length);
  ok('MC CAN- va au domestique', !!(out.proposals.mcDomestic || []).length);
  ok('MC INT- va à l\'international', !!(out.proposals.mcInternational || []).length);
  ok('Interac Flash va à interacFlash', !!(out.proposals.interacFlash || []).length);

  // ⚠️ Discover n'a pas de table d'interchange dans ce modèle. La ligne doit ressortir en
  // NON APPARIÉE et pas se faire ranger « quelque part » : un taux Discover logé dans la
  // table Visa produirait un « Conforme » sur une marque qui n'est pas la sienne.
  ok('Discover ressort en non appariée', out.unmapped.length === 1
    && out.unmapped[0].flags.includes('noTargetTable'), out.unmapped.map((u) => u.cat));
  ok('et n\'est dans aucune table', !flat(out).some((p) => /Discover|ÉLECTR INTERNATIONALE/.test(p.cat)));

  // Les lignes de groupe (un libellé seul sur sa ligne) ne sont pas des taux.
  // 6 lignes de données pour 4 en-têtes de groupe : le compte prouve que les en-têtes ont
  // bien été sautés.
  ok('les en-têtes de groupe ne deviennent pas des lignes', flat(out).length + out.unmapped.length === 6,
    flat(out).length + out.unmapped.length);
  ok('mais le groupe est conservé sur chaque ligne',
    find(out, 'PERSONNELLE').group.startsWith('VISA —'), find(out, 'PERSONNELLE').group);
}

// ---------------------------------------------------------------------------
// 2. LA règle du module : accord entre les deux acquéreurs = transfert réseau.
// ---------------------------------------------------------------------------
{
  // Tables VIDES exprès : ce cas mesure la règle d'accord, rien d'autre. Contre les vraies
  // tables — remplies le 2026-09-21 — 1,25 % heurte l'entrée « Visa Crédit conso. —
  // Électronique », ce qui est un heurt légitime mais brouille ce qu'on veut isoler ici.
  const out = read(build([
    icRow('Visa', 'CAN-CE01', 'ACCORD', 'Agreed', 0.0125, '', 0.0125, ''),
    icRow('Visa', 'CAN-CE02', 'DÉSACCORD', 'Disagreed', 0.0125, '', 0.0110, ''),
    icRow('Visa', 'CAN-CE03', 'SOURCE UNIQUE', 'Single source', 0.0130, '', '', ''),
  ], []), {});

  const agreed = find(out, 'ACCORD');
  const disagreed = find(out, 'DÉSACCORD');
  const single = find(out, 'SOURCE UNIQUE');

  ok('accord : proposé COCHÉ', agreed.accept === true && agreed.flags.length === 0, agreed.flags);
  ok('accord : la valeur retenue est la valeur commune', agreed.rate === 0.0125, agreed.rate);

  // ⚠️ Le cœur du sujet. Deux chiffres différents veulent dire qu'au moins l'un des deux
  // ajoute sa marge, et le classeur ne dit pas lequel. Charger l'un ou l'autre comme
  // « taux publié », c'est refaire le bug du 2026-09-21 (0,678 % = 0,60 % × 1,13 accepté
  // comme « Conforme »).
  ok('désaccord : proposé DÉCOCHÉ', disagreed.accept === false, disagreed);
  ok('désaccord : signalé comme tel', disagreed.flags.includes('acquirersDisagree'), disagreed.flags);
  ok('désaccord : les DEUX chiffres restent visibles',
    disagreed.observed.a === '1,2500 %' && disagreed.observed.b === '1,1000 %', disagreed.observed);
  ok('désaccord : aucune moyenne, aucune « plus basse »', disagreed.rate === 0.0125, disagreed.rate);

  ok('source unique : décochée aussi', single.accept === false && single.flags.includes('singleSource'), single.flags);
}

// ---------------------------------------------------------------------------
// 3. Une ligne de frais de réseau n'est JAMAIS cochée d'office, même en cas d'accord.
//
// ⚠️ C'est la distinction que le vrai classeur ne permet pas de vérifier (ses 11 lignes de
// frais de réseau sont toutes en désaccord), d'où ce cas construit. Un accord sur
// l'interchange prouve un transfert réseau ; un accord sur une évaluation ne prouve que la
// convergence de deux tarifications commerciales, et ces tables jugent du PUBLIÉ.
// ---------------------------------------------------------------------------
{
  // Tables VIDES exprès : ce cas isole la règle de cochage. Avec les vraies tables, la
  // ligne heurte l'évaluation Visa déjà en place à 0,0009 — un heurt légitime, mais qui
  // n'a rien à voir avec ce qu'on mesure ici.
  const out = read(build([], [
    ['VISA'],
    sfRow('Visa', 'VISA - ÉVALUATION IDENTIQUE', 'Visa identical assessment', '3', 0.0009, '', 0.0009, ''),
  ]), {});
  const row = find(out, 'IDENTIQUE');
  ok('frais de réseau : décoché même quand les deux s\'accordent', row.accept === false, row);
  ok('frais de réseau : aucun signalement mensonger pour autant', row.flags.length === 0, row.flags);
  ok('section 3 va dans networkFees', row.table === 'networkFees', row.table);
}

// ---------------------------------------------------------------------------
// 4. Aiguillage des frais de réseau par section, et Interac à part.
// ---------------------------------------------------------------------------
{
  const out = read(build([], [
    sfRow('Mastercard', 'MC - FRAIS COMPENSATION', 'Clearing fee', '4', '', 0.007966, '', 0.005247),
    sfRow('Visa', 'Visa - CVV2', 'Card verification', '5', '', 0.01, '', 0.002625),
    sfRow('Interac', 'INTERAC - ÉVALUATION', 'Interac assessment', '3', '', 0.015803, '', 0.01),
  ]));
  ok('section 4 va dans schemeFeesCA', find(out, 'COMPENSATION').table === 'schemeFeesCA');
  ok('section 5 va dans schemeFeesCA', find(out, 'CVV2').table === 'schemeFeesCA');
  // Interac passe avant la section : son évaluation est en section 3 mais n'a rien à faire
  // dans la table des frais de réseau des marques.
  ok('Interac va dans interacNetwork malgré la section 3',
    find(out, 'INTERAC').table === 'interacNetwork', find(out, 'INTERAC').table);
}

// ---------------------------------------------------------------------------
// 5. Les garde-fous de valeur.
// ---------------------------------------------------------------------------
{
  const out = read(build([
    icRow('Visa', 'CAN-A', 'POURCENTAGE BRUT', 'Raw percent', 1.25, '', 1.25, ''),
    icRow('Visa', 'CAN-B', 'RIEN DU TOUT', 'No value', '', '', '', ''),
    icRow('Visa', 'CAN-C', 'NÉGATIF', 'Negative', -0.01, '', -0.01, ''),
    icRow('Visa', 'CAN-D', 'LES DEUX', 'Both', 0.0125, 0.03, 0.0125, 0.03),
    icRow('Visa', 'CAN-E', 'PAR ITEM ÉNORME', 'Huge per item', '', 42, '', 42),
  ], []));

  // ⚠️ Un taux > 1 est une colonne laissée en pourcentage. On le SIGNALE, on ne divise
  // pas par 100 : deviner, c'est exactement ce que tout le reste du calculateur refuse.
  ok('1,25 signalé comme pourcentage brut', find(out, 'POURCENTAGE').flags.includes('looksLikePercent'));
  ok('et pas corrigé en douce', find(out, 'POURCENTAGE').rate === 1.25, find(out, 'POURCENTAGE').rate);
  ok('ligne vide signalée', find(out, 'RIEN').flags.includes('noValue'));
  ok('négatif signalé', find(out, 'NÉGATIF').flags.includes('negative'));
  ok('taux ET par-item ensemble signalés', find(out, 'LES DEUX').flags.includes('bothRateAndPerItem'));
  ok('par-item démesuré signalé', find(out, 'ÉNORME').flags.includes('perItemTooLarge'));
  ok('aucun de ces cinq n\'est coché', ['POURCENTAGE', 'RIEN', 'NÉGATIF', 'LES DEUX', 'ÉNORME']
    .every((f) => find(out, f).accept === false));
}

// ---------------------------------------------------------------------------
// 6. Heurts avec les tables en place.
//
// ⚠️ La question posée n'est pas « est-ce la même catégorie ? » — jugement que la machine
// rend mal, mesuré : au seuil du classificateur rien ne se déclenche, et en le baissant
// l'évaluation INTERNATIONALE se met à pointer la DOMESTIQUE. La question est mécanique :
// est-ce que charger cette ligne rendrait le classificateur ambigu ?
// ---------------------------------------------------------------------------
{
  const tables = {
    visaDomestic: [
      { cat: 'Visa — Personnelle électronique puce complète', rate: 0.0125, src: 'visa_published' },
      { cat: 'Visa — Infinite électronique', rate: 0.0157, src: 'visa_published' },
    ],
    networkFees: [{ cat: 'Mastercard — Frais d\'évaluation', rate: 0.0009, src: 'mc_published' }],
  };
  const out = read(build([
    icRow('Visa', 'CAN-A', 'Visa — Personnelle électronique puce complète', '', 0.0125, '', 0.0125, ''),
    icRow('Visa', 'CAN-B', 'Visa — Personnelle électronique puce complète', '', 0.0140, '', 0.0140, ''),
    icRow('Visa', 'CAN-C', 'TOUT AUTRE LIBELLÉ', 'Something else', 0.0157, '', 0.0157, ''),
  ], [
    sfRow('Visa', 'VISA - ÉVALUATION', 'Visa assessment', '3', 0.0009, '', 0.0009, ''),
  ]), tables);

  const same = flat(out).filter((p) => p.cat.startsWith('Visa — Personnelle'));
  ok('valeur et nom identiques -> déjà présente', same[0].flags.includes('alreadyPresent'), same[0].flags);
  ok('même nom, valeur différente -> heurt de nom', same[1].flags.includes('nameCollision'), same[1].flags);
  ok('nom différent, même taux -> heurt de valeur',
    find(out, 'TOUT AUTRE').flags.includes('valueCollision'), find(out, 'TOUT AUTRE').flags);
  ok('un heurt décoche la ligne', same[1].accept === false && find(out, 'TOUT AUTRE').accept === false);

  // ⚠️ Garde de marque, la même que celle du classificateur. Sans elle une ligne Visa se
  // déclare en heurt avec une entrée Mastercard dont le taux tombe dans l'epsilon, et
  // l'alarme désigne une entrée sans rapport — pire que le silence.
  const assess = find(out, 'VISA - ÉVALUATION');
  ok('pas de heurt inter-marques', !assess.collidesWith.some((c) => /Mastercard/.test(c.cat)),
    assess.collidesWith);
  ok('et pas de voisin d\'une autre marque', !assess.nearest || !/Mastercard/.test(assess.nearest.cat),
    assess.nearest);
}

// ---------------------------------------------------------------------------
// 7. Le voisinage est MONTRÉ avec sa ressemblance, jamais affirmé comme identité.
// ---------------------------------------------------------------------------
{
  const tables = { networkFees: [{ cat: 'Visa — Frais d\'évaluation (assessment, domestique)', rate: 0.0009, src: 'visa_published' }] };
  const out = read(build([], [
    sfRow('Visa', 'VISA - ÉVALUATION', 'Visa assessment', '3', 0.001017, '', 0.0009, ''),
  ]), tables);
  const row = find(out, 'VISA - ÉVALUATION');
  ok('le voisin existant est rendu', !!row.nearest, row.nearest);
  ok('avec son taux imprimé', row.nearest.printedAs === '0,0900 %', row.nearest.printedAs);
  ok('et sa ressemblance chiffrée', row.nearest.ratio > 0.5 && row.nearest.ratio < 1, row.nearest.ratio);
  ok('mais AUCUN heurt affirmé (0,1017 % vs 0,0900 % : hors epsilon, noms trop distants)',
    row.collidesWith.length === 0, row.collidesWith);
  ok('la ligne reste décochée par le désaccord', row.accept === false && row.flags.includes('acquirersDisagree'));
}

// ---------------------------------------------------------------------------
// 8. La feuille des majorations : lue pour information, jamais comme une source de taux.
// ---------------------------------------------------------------------------
{
  const out = read(build([], [], [
    ['ACQUIRER MARKUP — en-tête de groupe'],
    ['4', 'VISA - TRANSACTION', 'Visa transaction', 0.0015, '', '...', 149.59, 'Moneris markup', ''],
    ['4', 'VISA - FRAIS D\'ACCÈS AU SYSTÈME', 'System access fee', '', 0.0075, '...', 13.37, 'SUSPECT — hidden markup', ''],
    ['5', 'Location PDV', 'POS rental', '', 29.0, '1', 29.0, 'Moneris service fee', ''],
    ['', '', 'Total Moneris own charges', '', '', '', 546.88, '', ''],
  ]));
  ok('la classification est rendue', (out.classification || []).length === 3, out.classification);
  // ⚠️ La ligne de total n'a ni marque ni description : elle ne doit pas devenir une ligne.
  ok('la ligne de total est écartée',
    !(out.classification || []).some((c) => /Total/.test(String(c.desc) + String(c.reading))), out.classification);
  ok('aucune ligne de cette feuille ne devient un taux',
    flat(out).length === 0 && out.unmapped.length === 0, { p: flat(out).length, u: out.unmapped.length });
}

// ---------------------------------------------------------------------------
// 8bis. TARIF GROUPÉ — le refus le plus important du module.
//
// ⚠️ Tous les classeurs ne décrivent pas le même modèle tarifaire. Moneris facture en
// IC++ : sa feuille d'interchange contient vraiment l'interchange du réseau. Global
// facture au forfait : la sienne contient « Discount base — bundled interchange +
// acquirer markup », donc l'interchange ET la marge fondus, puis des lignes « IDF
// downgrade » qui sont des incréments additifs sur cette base.
//
// Chargées dans les tables, ces lignes y inscriraient la marge d'un acquéreur comme taux
// publié d'un réseau. Elles sont REFUSÉES, pas signalées : il n'y a aucune décision
// humaine à prendre, la valeur n'est pas de la nature attendue.
{
  const out = read(build([
    ['GLOBAL \'DISCOUNT\' — QUALIFIED BASE RATE (bundled interchange + acquirer markup)'],
    icRow('Visa', 'VISA', 'VISA (consumer core)', 'Discount base', 0.0128, '', 0.0128, ''),
    ['GLOBAL \'INTERCHANGE DOWNGRADE FEES\' (IDF) — ADDITIVE on top of the Discount base'],
    icRow('Visa', 'VIBSFGN', 'Visa Business Foreign', 'IDF downgrade', 0.014493, '', 0.014493, ''),
  ], []), {});

  ok('un tarif groupé n\'est proposé dans AUCUNE table', flat(out).length === 0, flat(out));
  ok('il ressort en non proposé', out.unmapped.length === 2, out.unmapped.length);
  ok('et le motif est nommé', out.unmapped.every((u) => u.flags.includes('bundledTariff')),
    out.unmapped.map((u) => u.flags));
  // ⚠️ Décisif : ces deux lignes ont des colonnes CONCORDANTES. Sans la détection du
  // tarif groupé, l'accord des deux acquéreurs les ferait arriver COCHÉES.
  ok('même concordantes, elles n\'arrivent jamais cochées',
    out.unmapped.every((u) => u.accept === false), out.unmapped.map((u) => u.accept));
}

// ---------------------------------------------------------------------------
// 8ter. LIBELLÉ ILLISIBLE — la garde qui rattrape un classeur inconnu.
//
// ⚠️ Les en-têtes changent d'un acquéreur à l'autre (« Moneris Description (as printed,
// FR) » contre « Global Fee Name (decoded) »). Quand la colonne de description ne se
// résout pas, `cat` retombe sur la seule marque : treize lignes toutes nommées « Visa »,
// indiscernables — et le module n'avait RIEN refusé, il avait rendu du plausible et faux.
//
// Élargir les motifs traite les classeurs connus ; cette garde traite le suivant.
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['titre'], [''],
    // En-têtes d'un acquéreur imaginaire : la description ne correspond à aucun motif.
    ['Card Brand', 'Tarif Code', 'Libellé maison', 'Genre', 'Tarif Rate %', 'Tarif Rate $/txn',
      'Adyen Equivalent Fee Name', 'Adyen Rate %', 'Adyen Rate $/txn', 'd', 'e', 'Match Confidence', 'Notes'],
    ['Visa', 'X1', 'PERSONNELLE ÉLECTRONIQUE', 'consommateur', 0.0125, '', 'x', 0.0125, '', '', '', 'High', ''],
  ]), 'Interchange Mapping');
  const out = read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), {});
  const row = flat(out)[0] || out.unmapped[0];
  ok('une ligne réduite à sa seule marque est signalée', !!row && row.flags.includes('catUnreadable'),
    row && { cat: row.cat, flags: row.flags });
  ok('et jamais cochée', !!row && row.accept === false, row && row.accept);
}

// ---------------------------------------------------------------------------
// 9. Refus francs.
// ---------------------------------------------------------------------------
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['rien'], ['du tout']]), 'Autre chose');
  const out = read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  ok('un classeur sans feuille connue est refusé', out.ok === false && out.reason === 'no_known_sheet', out);

  ok('un fichier vide est refusé', read(Buffer.alloc(0)).reason === 'no_file');
  ok('un fichier illisible est refusé', read(Buffer.from('ceci n\'est pas un classeur')).ok === false);

  // Une feuille au bon nom mais sans en-tête reconnaissable ne doit pas rendre des lignes
  // au hasard : elle doit se déclarer illisible.
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet([['a', 'b'], ['c', 'd']]), 'Interchange Mapping');
  const out2 = read(XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' }));
  ok('une feuille sans en-tête se déclare illisible',
    out2.sheetsRead.some((s) => s.error === 'header_not_found'), out2.sheetsRead);
  ok('et ne propose rien', flat(out2).length === 0);
}

// ---------------------------------------------------------------------------
// 10. Le vrai classeur, s'il est là.
//
// ⚠️ Il n'est PAS dans le dépôt (sa feuille des majorations porte les volumes d'un
// marchand identifiable). Quand il manque, ce bloc doit le DIRE : une assertion qui ne
// s'exécute pas ne prouve rien, et une suite verte qui laisse croire le contraire est
// exactement le piège relevé le 2026-09-19.
// ---------------------------------------------------------------------------
const REAL = process.env.ICPLUS_WORKBOOK
  || 'C:/Users/lafle/Downloads/Adyen vs Moneris - Fee Mapping - May 2026.xlsx';

if (fs.existsSync(REAL)) {
  const out = read(fs.readFileSync(REAL), T.RATE_TABLES);
  ok('[réel] le classeur est lu', out.ok === true, out.reason);
  ok('[réel] les deux feuilles de taux sont trouvées',
    out.sheetsRead.filter((s) => !s.error).length === 2, out.sheetsRead);

  // Les 19 en désaccord : 11 frais de réseau + 5 frais de système + 1 Interac + 2 Flash.
  ok('[réel] 19 lignes en désaccord', out.summary.disagree === 19, out.summary);

  // ⚠️ CE QUE L'IMPORTATEUR EST DEVENU depuis que les tables sont remplies (2026-09-21).
  //
  // Avant, 33 lignes d'interchange arrivaient cochées : les tables étaient vides, tout
  // était neuf. Maintenant ces 33 valeurs SONT DÉJÀ EN TABLE — chargées du calculateur de
  // référence — et l'importateur les signale en heurt de valeur au lieu de les reproposer.
  //
  // Et le heurt est de VALEUR, pas de nom : « PERSONNELLE-ÉLECTR-PUCE COMPLÈTES » (la
  // formulation du relevé Moneris) et « Visa Crédit conso. — Électronique (Classic/Gold/
  // Platinum) » (la catégorie de la référence) sont le MÊME frais au MÊME taux sous deux
  // plumes. C'est la preuve que les deux sources concordent — et le signe que ce classeur
  // ne vaut plus pour ses taux mais pour ses LIBELLÉS, qui restent à verser en alias.
  ok('[réel] les taux du classeur sont déjà en table, donc en heurt',
    out.summary.collisions >= 33, out.summary);
  ok('[réel] et ce sont des heurts de VALEUR, pas de nom',
    flat(out).filter((p) => p.flags.includes('valueCollision')).length >= 33,
    flat(out).filter((p) => p.flags.includes('valueCollision')).length);
  ok('[réel] donc presque plus rien n\'arrive coché', out.summary.accepted <= 3, out.summary.accepted);
  ok('[réel] la seule non appariée est Discover',
    out.unmapped.length === 1 && /INTERNATIONALE CANADA/.test(out.unmapped[0].cat), out.unmapped.map((u) => u.cat));

  // Aucune ligne de frais de réseau ne peut arriver cochée : elles sont toutes en
  // désaccord, donc toutes du facturé, donc aucune n'entre sans décision humaine.
  ok('[réel] aucune ligne de frais de réseau n\'arrive cochée',
    !(out.proposals.networkFees || []).some((p) => p.accept));

  // ⚠️ Corroboration indépendante. Les trois lignes que le classeur classe « SUSPECT —
  // hidden markup » doivent être exactement celles que rateTables traite en majoration
  // d'acquéreur. Si l'une des deux listes bouge sans l'autre, ce test le dit.
  const sus = (out.classification || []).filter((c) => /SUSPECT/i.test(c.classification)).map((c) => c.desc);
  const coded = T.MONERIS_ACQUIRER_MARKUP_ROWS.map((s) => s.toUpperCase());
  ok('[réel] 3 lignes classées SUSPECT dans le classeur', sus.length === 3, sus);
  ok('[réel] et ce sont celles codées en majoration d\'acquéreur',
    sus.every((d) => coded.includes(String(d).toUpperCase())), { sus, coded });
} else {
  console.log('SKIP [réel] classeur absent de cette machine — 8 assertions NON exécutées.');
  console.log('     Pour les jouer : ICPLUS_WORKBOOK=<chemin du .xlsx> node ' + __filename.split(/[\\/]/).pop());
}

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
