// ============================================================================
// Courriels du module Opener. Internes (Sales Hub), bilingues, français d'abord.
// Enregistrés dans l'outil d'aperçu (Admin → Notifications) : type `opener_route_published`.
// ============================================================================

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// d = { openerName, routeName, dateFr, dateEn, stops: [{ name, address }], publishedBy, link }
function routePublishedEmail(mailShell, d) {
  const n = (d.stops || []).length;
  const subject = `🗺️ Route du ${d.dateFr} : ${d.routeName} (${n} arrêt${n > 1 ? 's' : ''}) / Route for ${d.dateEn}`;
  const list = (d.stops || []).slice(0, 30).map((s, i) =>
    `<tr><td style="padding:4px 10px 4px 0;color:#94a3b8;font-size:13px;vertical-align:top">${i + 1}.</td>`
    + `<td style="padding:4px 0;font-size:13.5px"><b style="color:#0f1722">${esc(s.name)}</b>`
    + `${s.address ? `<br><span style="color:#64748b">${esc(s.address)}</span>` : ''}</td></tr>`).join('');
  const intro = `<p style="margin:0 0 12px">Bonjour ${esc(d.openerName || '')},</p>`
    + `<p style="margin:0 0 12px">Ta route du <b>${esc(d.dateFr)}</b> est prête : <b>${esc(d.routeName)}</b>, ${n} arrêt${n > 1 ? 's' : ''}`
    + `${d.publishedBy ? `, préparée par ${esc(d.publishedBy)}` : ''}. Ouvre-la sur ton téléphone pour la carte, les fiches et les check-ins.</p>`
    + `<p style="margin:0 0 14px;color:#64748b">Your route for <b>${esc(d.dateEn)}</b> is ready — ${n} stop${n > 1 ? 's' : ''}. Open it on your phone.</p>`
    + (list ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 6px">${list}</table>` : '');
  return { subject, html: mailShell('Ta route est prête · Your route is ready', intro, 'Ouvrir la route / Open the route', d.link) };
}

// La semaine d'un opener (campagne) : UN courriel pour ses 5 routes, au lieu de 5.
// d = { openerName, weekFr, weekEn, days: [{ dateFr, dateEn, name, stops, minutes, mode }], publishedBy, link }
function weekPublishedEmail(mailShell, d) {
  const days = d.days || [];
  const subject = `🗺️ Ta semaine du ${d.weekFr} : ${days.length} route${days.length > 1 ? 's' : ''} / Your week of ${d.weekEn}`;
  const rows = days.map((x) =>
    `<tr><td style="padding:6px 12px 6px 0;font-size:13.5px;vertical-align:top;white-space:nowrap"><b style="color:#0f1722">${esc(x.dateFr)}</b></td>`
    + `<td style="padding:6px 0;font-size:13.5px;color:#334155">${esc(x.name)}<br><span style="color:#64748b">${x.stops} arrêts · ~${Math.round(x.minutes / 60 * 10) / 10} h · ${x.mode === 'car' ? 'en voiture' : 'à pied'}</span></td></tr>`).join('');
  const intro = `<p style="margin:0 0 12px">Bonjour ${esc(d.openerName || '')},</p>`
    + `<p style="margin:0 0 12px">Voici tes routes de la semaine du <b>${esc(d.weekFr)}</b>${d.publishedBy ? `, préparées par ${esc(d.publishedBy)}` : ''}. Chaque matin, ouvre l'application sur ton téléphone : la route du jour t'attend.</p>`
    + `<p style="margin:0 0 14px;color:#64748b">Your routes for the week of <b>${esc(d.weekEn)}</b> are ready. Open the app on your phone each morning.</p>`
    + (rows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 6px">${rows}</table>` : '');
  return { subject, html: mailShell('Ta semaine est prête · Your week is ready', intro, 'Ouvrir l\'application / Open the app', d.link) };
}

module.exports = { routePublishedEmail, weekPublishedEmail };
