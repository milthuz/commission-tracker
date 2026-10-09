// Jours fériés du Québec : la planification des routes les saute, comme les fins de semaine.
// Ajouté le 2026-10-09 : la semaine de Hao commençait le lundi 12 octobre, Action de grâce.
//
// Liste : jour de l'An, Vendredi saint, lundi de Pâques, Journée nationale des patriotes (lundi
// précédant le 25 mai), Fête nationale (24 juin), fête du Canada (1er juillet), fête du Travail
// (1er lundi de septembre), Action de grâce (2e lundi d'octobre), Noël, lendemain de Noël.

const ymd = (d) => d.toISOString().slice(0, 10);
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

// Pâques (algorithme grégorien anonyme).
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(y, month, day);
}
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
// n-ième lundi d'un mois (1 = premier).
function nthMonday(y, m, n) {
  const first = utc(y, m, 1);
  const shift = (8 - first.getUTCDay()) % 7; // jours jusqu'au premier lundi
  return addDays(first, shift + 7 * (n - 1));
}

const cache = new Map();
function holidaysOf(y) {
  if (cache.has(y)) return cache.get(y);
  const e = easter(y);
  const may25 = utc(y, 5, 25);
  const patriotes = addDays(may25, -(((may25.getUTCDay() + 6) % 7) || 7)); // lundi STRICTEMENT avant le 25
  const list = new Map([
    [ymd(utc(y, 1, 1)), "Jour de l'An"],
    [ymd(addDays(e, -2)), 'Vendredi saint'],
    [ymd(addDays(e, 1)), 'Lundi de Pâques'],
    [ymd(patriotes), 'Journée nationale des patriotes'],
    [ymd(utc(y, 6, 24)), 'Fête nationale du Québec'],
    [ymd(utc(y, 7, 1)), 'Fête du Canada'],
    [ymd(nthMonday(y, 9, 1)), 'Fête du Travail'],
    [ymd(nthMonday(y, 10, 2)), 'Action de grâce'],
    [ymd(utc(y, 12, 25)), 'Noël'],
    [ymd(utc(y, 12, 26)), 'Lendemain de Noël'],
  ]);
  cache.set(y, list);
  return list;
}

// Nom du jour férié, ou null.
const holidayName = (dateYmd) => holidaysOf(Number(String(dateYmd).slice(0, 4))).get(String(dateYmd).slice(0, 10)) || null;
const isHoliday = (dateYmd) => !!holidayName(dateYmd);

module.exports = { isHoliday, holidayName, holidaysOf };
