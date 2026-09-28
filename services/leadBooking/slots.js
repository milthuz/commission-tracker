// ============================================================================
// Créneaux de rendez-vous — calcul PUR, sans base ni réseau, pour pouvoir être testé seul.
//
// Tout se calcule en heure de MUR de l'entreprise (America/Toronto par défaut), jamais avec
// l'heure locale du processus : Railway tourne en UTC, et « 9 h » y deviendrait 5 h du matin à
// Montréal. Même mécanique Intl que leadCallbackAt() dans server.js, recopiée ici pour que ce
// fichier reste autonome (et testable sous n'importe quel TZ).
// ============================================================================

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}
function parts(d, tz) {
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(d)) if (type !== 'literal') p[type] = parseInt(value, 10);
  if (p.hour === 24) p.hour = 0;
  return p;
}
function offsetMin(d, tz) {
  const p = parts(d, tz);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - d.getTime()) / 60000);
}
// Instant correspondant à une heure de mur ; deux passes pour les changements d'heure.
function wall(tz, y, m, d, h, min = 0) {
  let t = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) t = Date.UTC(y, m - 1, d, h, min) - offsetMin(new Date(t), tz) * 60000;
  return new Date(t);
}
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = dimanche

// Retire [cut.start, cut.end) de chaque intervalle occupé. Sert à ne pas compter comme « occupé »
// le rendez-vous ACTUEL du client : Google le rend fusionné avec ses voisins, donc on le
// soustrait au lieu de chercher un bloc identique.
function subtract(busy, cut) {
  if (!cut) return busy;
  const out = [];
  for (const b of busy) {
    if (b.end <= cut.start || b.start >= cut.end) { out.push(b); continue; }
    if (b.start < cut.start) out.push({ start: b.start, end: cut.start });
    if (b.end > cut.end) out.push({ start: cut.end, end: b.end });
  }
  return out;
}

const overlaps = (s, e, busy) => busy.some((b) => s < b.end && e > b.start);

// La fenêtre à interroger chez Google : de maintenant jusqu'à la fin du dernier jour ouvrable
// proposé (+1 jour de marge pour les fuseaux).
function window({ now = new Date(), days = 5, tz = 'America/Toronto' }) {
  const p = parts(now, tz);
  let found = 0, y = p.year, m = p.month, d = p.day, last = null;
  for (let i = 0; i < 30 && found < days; i++) {
    const date = new Date(Date.UTC(y, m - 1, d + i));
    const [yy, mm, dd] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const w = dow(yy, mm, dd);
    if (w === 0 || w === 6) continue;
    found++; last = [yy, mm, dd];
  }
  return { timeMin: now, timeMax: wall(tz, last[0], last[1], last[2] + 1, 23, 59) };
}

// Les créneaux libres, groupés par jour.
//   busy        : [{start, end}] — plages occupées (Google + rendez-vous déjà pris dans Sales Hub)
//   exclude     : {start, end}   — le rendez-vous actuel du client, à ne pas compter contre lui
//   days        : nombre de jours OUVRABLES proposés (un jour sans aucun créneau restant, comme
//                 aujourd'hui passé 17 h, n'est pas compté)
//   slotMinutes : durée d'un rendez-vous, et pas de la grille
//   minNoticeHours : rien avant maintenant + ce délai
// → [{ date: 'YYYY-MM-DD', slots: [ISO…] }]
function computeSlots({
  now = new Date(), busy = [], exclude = null, days = 5, slotMinutes = 30, minNoticeHours = 2,
  businessHours = { start: 9, end: 17 }, tz = 'America/Toronto',
}) {
  const start = Math.min(23, Math.max(0, parseInt(businessHours.start, 10) || 9));
  const end = Math.min(24, Math.max(start + 1, parseInt(businessHours.end, 10) || 17));
  const step = Math.min(240, Math.max(10, parseInt(slotMinutes, 10) || 30));
  const earliest = now.getTime() + Math.max(0, Number(minNoticeHours) || 0) * 3600000;
  const blocks = subtract(busy, exclude);

  const out = [];
  const p = parts(now, tz);
  for (let i = 0; i < 40 && out.length < days; i++) {
    const date = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const w = dow(y, m, d);
    if (w === 0 || w === 6) continue;
    const dayEnd = wall(tz, y, m, d, end);
    if (dayEnd.getTime() - step * 60000 < earliest) continue; // plus rien de possible ce jour-là

    const slots = [];
    for (let t = wall(tz, y, m, d, start).getTime(); t + step * 60000 <= dayEnd.getTime(); t += step * 60000) {
      if (t < earliest) continue;
      const s = new Date(t), e = new Date(t + step * 60000);
      if (!overlaps(s, e, blocks)) slots.push(s.toISOString());
    }
    // Un jour ouvrable entièrement pris compte quand même : le client voit « complet » plutôt
    // qu'un calendrier qui saute des jours sans explication.
    out.push({ date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, slots });
  }
  return out;
}

// Le premier créneau libre à partir d'un instant — l'heure PROPOSÉE à l'acceptation.
function firstFreeFrom(daysList, from) {
  const t = from.getTime();
  for (const day of daysList) for (const s of day.slots) if (new Date(s).getTime() >= t) return new Date(s);
  return null;
}

module.exports = { computeSlots, firstFreeFrom, window, subtract, _wall: wall };
