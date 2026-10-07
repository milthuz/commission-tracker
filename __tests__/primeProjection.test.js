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
