// Payer la commission d'UNE facture (demande de David, 2026-10-05).
//
// Ce qui se joue ici : quand on paie une facture à l'unité, le bulletin de paie du mois doit
// être reconstruit — sinon le représentant touche de l'argent qu'aucun document ne justifie.
// Encore faut-il viser le BON mois.
//
// ⚠️ Le piège : le pilote `pg` construit un `Date` à MINUIT LOCAL pour une colonne `date`.
// Lu avec `getUTCMonth()` depuis un fuseau POSITIF — Tokyo, UTC+9 —, minuit local le 1er
// octobre vaut 15 h UTC le 30 septembre : la facture irait grossir le bulletin du mois
// précédent, en silence. Toronto (UTC-4) s'en sort, et Railway tourne en UTC : c'est
// précisément ce qui rend ce défaut invisible ici.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// `ymd` et `periodesTouchees` sont synchrones : l'extracteur partagé ne découpe que les `async`.
function decouper(entete) {
  const d = SOURCE.indexOf(entete);
  if (d === -1) throw new Error(`${entete} introuvable dans server.js`);
  const f = SOURCE.indexOf('\n}', d);
  if (f === -1) throw new Error(`fin de ${entete} introuvable`);
  return SOURCE.slice(d, f + 2);
}

function monter() {
  const bac = { console: { warn() {}, error() {} }, Date, String, Number, Map, Array };
  vm.createContext(bac);
  // ⚠️ Un `const` déclaré dans un script `vm` reste lexical : il n'apparaît PAS sur l'objet de
  // contexte. Une déclaration de fonction, si. D'où l'export explicite de `ymd`.
  vm.runInContext(
    `${decouper('const ymd = (v) => {')}\n${decouper('function periodesTouchees(rows) {')}\nthis.ymd = ymd;`,
    bac);
  return bac;
}

// Rejoue ce que fait `pg` pour une colonne `date` : un Date à MINUIT LOCAL.
const commePg = (iso) => {
  const [a, m, j] = iso.split('-').map(Number);
  return new Date(a, m - 1, j);
};

describe('periodesTouchees', () => {
  const { periodesTouchees, ymd } = monter();

  test('temoin : une facture donne son representant et son mois', () => {
    expect(periodesTouchees([
      { salesperson_name: 'Sophie', commission_payable_date: commePg('2026-10-15') },
    ])).toEqual([{ rep: 'Sophie', year: 2026, month: 10 }]);
  });

  test('deux factures du MEME mois ne reconstruisent le bulletin qu’une fois', () => {
    expect(periodesTouchees([
      { salesperson_name: 'Sophie', commission_payable_date: commePg('2026-10-02') },
      { salesperson_name: 'Sophie', commission_payable_date: commePg('2026-10-28') },
    ])).toHaveLength(1);
  });

  test('plusieurs representants et plusieurs mois sont tous couverts', () => {
    const out = periodesTouchees([
      { salesperson_name: 'Sophie', commission_payable_date: commePg('2026-10-02') },
      { salesperson_name: 'Sophie', commission_payable_date: commePg('2026-11-02') },
      { salesperson_name: 'Marc', commission_payable_date: commePg('2026-10-02') },
    ]);
    expect(out).toHaveLength(3);
    expect(out).toContainEqual({ rep: 'Marc', year: 2026, month: 10 });
    expect(out).toContainEqual({ rep: 'Sophie', year: 2026, month: 11 });
  });

  // Les dates qui basculent. Vrai dans N'IMPORTE QUEL fuseau, parce que `ymd()` lit les
  // composantes LOCALES du Date que `pg` a construit a minuit local.
  //
  // ⚠️ NON DEMONTRE SOUS PLUSIEURS FUSEAUX, et il faut le dire. Deux tentatives ont echoue :
  //   1. changer `process.env.TZ` DANS le test — inutile, Node lit le fuseau au demarrage ;
  //      les trois cas passaient alors pour rien.
  //   2. `TZ=Asia/Tokyo npx jest …` depuis Git Bash sous Windows — la variable n'arrive meme
  //      pas jusqu'au processus (`process.env.TZ` vaut `undefined`), et ICU reste sur le fuseau
  //      de la machine. Les « trois fuseaux » tournaient tous en America/Toronto.
  // A rejouer sous Linux/CI si on veut la preuve : `TZ=Asia/Tokyo npx jest paiementParFacture`.
  //
  // Ce qui EST garanti sans dependre du fuseau : `ymd()` relit les composantes LOCALES du Date
  // que `pg` a construit a minuit local — donc il rend toujours le jour ECRIT dans la colonne.
  // C'est l'objet du test « ymd rend le jour du calendrier » plus bas.
  test.each(['2026-10-01', '2026-10-31', '2026-01-01', '2026-12-31'])('la date charniere %s tient', (iso) => {
    const [an, mois] = iso.split('-').map(Number);
    expect(periodesTouchees([{ salesperson_name: 'Sophie', commission_payable_date: commePg(iso) }]))
      .toEqual([{ rep: 'Sophie', year: an, month: mois }]);
  });

  // TEMOIN — `ymd()` suit bien le calendrier LOCAL, la ou `getUTC*` suit l'instant absolu. Sous
  // TZ=Asia/Tokyo les deux divergent d'un jour sur une date a minuit local ; sous UTC ils
  // coincident. On n'affirme donc pas la divergence (elle depend du fuseau d'execution), on
  // verifie que c'est bien `ymd` qui rend le jour ECRIT dans la colonne.
  test('ymd rend le jour du calendrier, quel que soit le fuseau', () => {
    for (const iso of ['2026-10-01', '2026-01-01', '2026-07-09']) {
      expect(ymd(commePg(iso))).toBe(iso);
    }
    expect(process.env.TZ || '(fuseau du systeme)').toBeTruthy();   // trace dans la sortie
  });

  test('une ligne sans représentant ou sans date est ignorée, pas devinée', () => {
    expect(periodesTouchees([
      { salesperson_name: null, commission_payable_date: commePg('2026-10-01') },
      { salesperson_name: 'Sophie', commission_payable_date: null },
      { salesperson_name: 'Sophie' },
    ])).toEqual([]);
  });

  test('une liste vide ou absente ne fait pas planter', () => {
    expect(periodesTouchees([])).toEqual([]);
    expect(periodesTouchees(null)).toEqual([]);
    expect(periodesTouchees(undefined)).toEqual([]);
  });

  test('une date déjà en chaîne « AAAA-MM-JJ » est acceptée telle quelle', () => {
    expect(periodesTouchees([{ salesperson_name: 'Sophie', commission_payable_date: '2026-07-09' }]))
      .toEqual([{ rep: 'Sophie', year: 2026, month: 7 }]);
  });
});
