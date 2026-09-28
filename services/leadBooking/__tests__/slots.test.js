const { computeSlots, firstFreeFrom, subtract, window: win, _wall: wall } = require('../slots');

const TZ = 'America/Toronto';
const at = (y, m, d, h, min = 0) => wall(TZ, y, m, d, h, min);

describe('computeSlots', () => {
  // Lundi 28 septembre 2026, 8 h à Montréal.
  const now = at(2026, 9, 28, 8);

  test('5 jours ouvrables, grille de 30 min, 9 h–17 h, fin de semaine sautée', () => {
    const days = computeSlots({ now, days: 5, minNoticeHours: 2 });
    expect(days.map((d) => d.date)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    // Lundi : 8 h + 2 h d'avis → premier créneau 10 h ; dernier 16 h 30.
    expect(days[0].slots[0]).toBe(at(2026, 9, 28, 10).toISOString());
    expect(days[0].slots[days[0].slots.length - 1]).toBe(at(2026, 9, 28, 16, 30).toISOString());
    expect(days[1].slots).toHaveLength(16);
  });

  test('un jour déjà terminé ne compte pas parmi les 5', () => {
    const late = at(2026, 10, 2, 16); // vendredi 16 h : 16 h + 2 h dépasse 17 h
    const days = computeSlots({ now: late, days: 5, minNoticeHours: 2 });
    expect(days[0].date).toBe('2026-10-05');
    expect(days).toHaveLength(5);
  });

  test('les plages occupées retirent les créneaux qui les chevauchent', () => {
    const busy = [{ start: at(2026, 9, 29, 10, 15), end: at(2026, 9, 29, 11) }];
    const tue = computeSlots({ now, busy, days: 2 })[1].slots;
    expect(tue).not.toContain(at(2026, 9, 29, 10).toISOString());
    expect(tue).not.toContain(at(2026, 9, 29, 10, 30).toISOString());
    expect(tue).toContain(at(2026, 9, 29, 11).toISOString());
    expect(tue).toContain(at(2026, 9, 29, 9, 30).toISOString());
  });

  test('le rendez-vous actuel du client ne compte pas contre lui, même fusionné', () => {
    // Google rend UN bloc 10 h–11 h : notre rendez-vous (10 h–10 h 30) + un autre (10 h 30–11 h).
    const busy = [{ start: at(2026, 9, 29, 10), end: at(2026, 9, 29, 11) }];
    const exclude = { start: at(2026, 9, 29, 10), end: at(2026, 9, 29, 10, 30) };
    const tue = computeSlots({ now, busy, exclude, days: 2 })[1].slots;
    expect(tue).toContain(at(2026, 9, 29, 10).toISOString());
    expect(tue).not.toContain(at(2026, 9, 29, 10, 30).toISOString());
  });

  test('changement d\'heure : 9 h reste 9 h de mur le lundi 2 novembre', () => {
    const days = computeSlots({ now: at(2026, 10, 30, 18), days: 1, minNoticeHours: 0 });
    expect(days[0].date).toBe('2026-11-02');
    expect(days[0].slots[0]).toBe('2026-11-02T14:00:00.000Z'); // HNE = UTC−5
  });

  test('indépendant du fuseau du processus', () => {
    // Même calcul, réponse identique : aucune fonction locale de Date n'est utilisée.
    const a = computeSlots({ now, days: 1 });
    expect(a[0].slots[0]).toBe('2026-09-28T14:00:00.000Z'); // HAE = UTC−4
  });
});

test('firstFreeFrom prend le premier créneau à partir de l\'instant', () => {
  const days = computeSlots({ now: at(2026, 9, 28, 8), days: 2 });
  expect(firstFreeFrom(days, at(2026, 9, 28, 12, 10)).toISOString()).toBe(at(2026, 9, 28, 12, 30).toISOString());
  expect(firstFreeFrom(days, at(2026, 12, 1, 9))).toBeNull();
});

test('subtract coupe un bloc en deux', () => {
  const r = subtract([{ start: at(2026, 9, 29, 9), end: at(2026, 9, 29, 12) }],
    { start: at(2026, 9, 29, 10), end: at(2026, 9, 29, 10, 30) });
  expect(r).toHaveLength(2);
});

test('window couvre jusqu\'au 5e jour ouvrable', () => {
  const w = win({ now: at(2026, 9, 28, 8), days: 5 });
  expect(w.timeMax.getTime()).toBeGreaterThan(at(2026, 10, 2, 23).getTime());
});
