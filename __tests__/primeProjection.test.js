// Projection de la prime semestrielle sur le tableau de bord d'un représentant
// (demande de David, 2026-10-07).
//
// Ce qu'on teste ici est le choix de la PÉRIODE. Se tromper afficherait à un rep une projection
// pour un versement déjà payé — il verrait deux fois le même argent, et le découvrirait en ne
// le recevant pas.
const { monter } = require('../test-utils/extraireDeServer');

const bac = monter('prochainVersementPrime');
const { prochainVersementPrime } = bac;

// `estCommite` injecté : la règle se teste sans base de données.
const rienDeCommite = async () => false;
const commite = (...periodes) => async (y, m) => periodes.includes(`${y}-${m}`);

// Un Date local au jour dit — `getMonth()` lit les composantes locales, comme la fonction.
const le = (y, m, d = 15) => new Date(y, m - 1, d);

describe('prochainVersementPrime', () => {
  test('témoin : en octobre, le prochain versement est décembre de la même année', async () => {
    expect(await prochainVersementPrime(le(2026, 10), rienDeCommite)).toEqual({ year: 2026, month: 12 });
  });

  test.each([[1], [2], [3], [4], [5], [6]])('en mois %i, on vise juin', async (m) => {
    expect(await prochainVersementPrime(le(2026, m), rienDeCommite)).toEqual({ year: 2026, month: 6 });
  });

  test.each([[7], [8], [9], [10], [11], [12]])('en mois %i, on vise décembre', async (m) => {
    expect(await prochainVersementPrime(le(2026, m), rienDeCommite)).toEqual({ year: 2026, month: 12 });
  });

  // LE cas qui compte. Juin 2026 EST commité en production (50 lignes, 4 reps, 1 662,85 $).
  test('juin déjà commité, on est en juin : on passe à décembre', async () => {
    expect(await prochainVersementPrime(le(2026, 6), commite('2026-6')))
      .toEqual({ year: 2026, month: 12 });
  });

  test('décembre déjà commité, on est en décembre : on passe à juin de l’ANNÉE SUIVANTE', async () => {
    expect(await prochainVersementPrime(le(2026, 12), commite('2026-12')))
      .toEqual({ year: 2027, month: 6 });
  });

  test('un commit d’une AUTRE période ne déplace rien', async () => {
    // Juin 2026 commité, mais on est en octobre : décembre reste la cible, pas juin 2027.
    expect(await prochainVersementPrime(le(2026, 10), commite('2026-6')))
      .toEqual({ year: 2026, month: 12 });
  });

  test('on ne saute qu’UNE fois — deux périodes commitées ne font pas boucler', async () => {
    // Si juin ET décembre 2026 sont commités, on s'arrête à décembre plutôt que de chercher
    // indéfiniment : mieux vaut une projection vide qu'une boucle ou une période lointaine
    // sortie de nulle part.
    const out = await prochainVersementPrime(le(2026, 6), commite('2026-6', '2026-12'));
    expect(out).toEqual({ year: 2026, month: 12 });
  });

  test('le passage d’année de fin décembre est correct', async () => {
    expect(await prochainVersementPrime(le(2026, 12, 31), rienDeCommite)).toEqual({ year: 2026, month: 12 });
    expect(await prochainVersementPrime(le(2027, 1, 1), rienDeCommite)).toEqual({ year: 2027, month: 6 });
  });
});

// ── bornesRevenus ───────────────────────────────────────────────────────────────────────────
// Le prédicat qui décide si la prime d'un compte est DÉFINITIVE. Partagé par l'écran du
// représentant et l'onglet Bonus de l'admin : s'il divergeait, un rep lirait un montant et son
// gestionnaire un autre.
//
// 🔑 La comparaison se fait en chaîne « AAAA-MM ». Aucun objet Date n'est construit, donc aucun
// fuseau ne peut décaler le mois — le piège qui guette toute colonne `date` relue en JavaScript.
const vm2 = require('vm');
const fs2 = require('fs');
const path2 = require('path');

function monterBornes(moisMax) {
  const SRC = fs2.readFileSync(path2.join(__dirname, '..', 'server.js'), 'utf8');
  const prendre = (entete) => {
    const d = SRC.indexOf(entete);
    if (d === -1) throw new Error(`${entete} introuvable`);
    return SRC.slice(d, SRC.indexOf('\n}', d) + 2);
  };
  const bac = {
    console,
    Date, String, Number,
    // Le pilote pg rend un Date à MINUIT LOCAL pour une colonne `date`.
    pool: { query: async () => ({ rows: [{ m: moisMax ? new Date(...moisMax) : null }] }) },
  };
  vm2.createContext(bac);
  vm2.runInContext(`${prendre('const ymd = (v) => {')}\n${prendre('async function bornesRevenus() {')}`, bac);
  return bac.bornesRevenus();
}

describe('bornesRevenus', () => {
  test('témoin : les données vont jusqu’au mois trouvé en base', async () => {
    const { dataThrough } = await monterBornes([2026, 9, 1]);   // octobre (mois 0-indexé)
    expect(dataThrough).toBe('2026-10');
  });

  test('une fenêtre qui se termine AVANT la fin des données est close', async () => {
    const { clos } = await monterBornes([2026, 9, 1]);          // données → 2026-10
    expect(clos('2026-06')).toBe(true);
    expect(clos('2026-09')).toBe(true);
  });

  test('une fenêtre qui se termine LE mois des données est close', async () => {
    const { clos } = await monterBornes([2026, 9, 1]);
    expect(clos('2026-10')).toBe(true);     // le mois est couvert, donc définitif
  });

  test('une fenêtre qui dépasse les données reste OUVERTE', async () => {
    const { clos } = await monterBornes([2026, 9, 1]);
    expect(clos('2026-11')).toBe(false);
    expect(clos('2027-01')).toBe(false);
  });

  // Le passage d'année : « 2027-01 » > « 2026-12 » en comparaison de chaînes, ce qui est bien
  // l'ordre chronologique. C'est ce qui rend l'astuce valable.
  test('le passage d’année est correct en comparaison de chaînes', async () => {
    const { clos } = await monterBornes([2026, 11, 1]);         // données → 2026-12
    expect(clos('2026-12')).toBe(true);
    expect(clos('2027-01')).toBe(false);
    const b2 = await monterBornes([2027, 0, 1]);                // données → 2027-01
    expect(b2.clos('2026-12')).toBe(true);
    expect(b2.clos('2027-02')).toBe(false);
  });

  test('sans données de revenus, RIEN n’est déclaré définitif', async () => {
    const { dataThrough, clos } = await monterBornes(null);
    expect(dataThrough).toBeNull();
    expect(clos('2026-06')).toBe(false);    // prudence : on n'annonce pas un acquis qu'on ignore
  });

  test('une fenêtre absente n’est pas close', async () => {
    const { clos } = await monterBornes([2026, 9, 1]);
    for (const v of [null, undefined, '']) expect(clos(v)).toBe(false);
  });
});
