// ============================================================================
// Courriels du rendez-vous — les constructeurs, sans envoi (l'aperçu d'Admin → Notifications
// appelle exactement les mêmes).
//
// Au MARCHAND : unilingue dans la langue de la piste, marque Cluster (`cluster-plain`), même règle
// que le courriel de bienvenue. Au REPRÉSENTANT : bilingue, enveloppe Sales Hub, comme les autres
// avis internes des pistes.
// ============================================================================

const TZ = 'America/Toronto';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function whenLabel(at, lang) {
  if (!at) return null;
  return new Date(at).toLocaleString(lang === 'en' ? 'en-CA' : 'fr-CA', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
  });
}

const P = 'margin:0 0 14px;color:#475569;font-size:14.5px;line-height:1.65';
function button(label, url) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr><td style="border-radius:9px;background:#f97316">
    <a href="${esc(url)}" style="display:inline-block;padding:13px 28px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:9px">${label}</a>
  </td></tr></table>`;
}
// `meet` : { url, label } — le lien Google Meet sous l'heure, quand l'événement en a un.
function whenBox(label, value, meet) {
  return `<div style="margin:18px 0;padding:16px 18px;background:#fff7ed;border-radius:10px;border:1px solid #fed7aa">
    <p style="margin:0 0 4px;color:#9a3412;font-size:11px;text-transform:uppercase;font-weight:700;letter-spacing:.4px">${label}</p>
    <p style="margin:0;color:#0f1722;font-size:17px;font-weight:700">${esc(value)}</p>
    ${meet?.url ? `<p style="margin:10px 0 0;font-size:14px">${meet.label} : <a href="${esc(meet.url)}" style="color:#1a73e8;font-weight:700;text-decoration:none">${esc(meet.url.replace(/^https?:\/\//, ''))}</a></p>` : ''}
  </div>`;
}
const meetLabel = (lang) => (lang === 'en' ? 'Join with Google Meet' : 'Rejoindre par Google Meet');

// Le bloc « votre rendez-vous » du courriel de BIENVENUE : l'heure proposée + le bouton pour en
// choisir une autre. Sans heure (aucun rappel planifié), le bouton invite à en choisir une.
function welcomeBookingBlock({ lang, at, bookingUrl, meetUrl }) {
  if (!bookingUrl) return '';
  const fr = lang !== 'en';
  const when = whenLabel(at, lang);
  return (when ? whenBox(fr ? 'Rendez-vous proposé' : 'Proposed meeting', when, { url: meetUrl, label: meetLabel(lang) }) : '')
    + `<p style="${P}">${when
      ? (fr ? 'Ce moment ne vous convient pas ? Choisissez-en un autre en un clic — la disponibilité de votre conseiller est à jour.'
            : "Doesn't work for you? Pick another time in one click — your advisor's availability is live.")
      : (fr ? 'Choisissez le moment qui vous convient pour un premier appel — la disponibilité de votre conseiller est à jour.'
            : "Pick a time that works for a first meeting — your advisor's availability is live.")}</p>`
    + button(when ? (fr ? 'Choisir un autre moment' : 'Pick another time') : (fr ? 'Choisir un moment' : 'Pick a time'), bookingUrl);
}

// Au marchand, après qu'il a choisi, changé ou annulé.
//   kind: 'booked' | 'cancelled'
function clientConfirmEmail(mailChrome, { lang, firstName, businessName, repName, repEmail, at, bookingUrl, meetUrl, kind, home }) {
  const fr = lang !== 'en';
  const hello = fr ? (firstName ? `Bonjour ${esc(firstName)},` : 'Bonjour,') : (firstName ? `Hi ${esc(firstName)},` : 'Hello,');
  const who = repName ? esc(repName) : (fr ? 'votre conseiller' : 'your advisor');
  let title, body;
  if (kind === 'cancelled') {
    title = fr ? 'Votre rendez-vous est annulé' : 'Your meeting is cancelled';
    body = `<p style="${P}">${hello}</p>`
      + `<p style="${P}">${fr ? `C'est noté : le rendez-vous avec ${who} au sujet de <strong>${esc(businessName)}</strong> est annulé.` : `Got it — your meeting with ${who} about <strong>${esc(businessName)}</strong> is cancelled.`}</p>`
      + `<p style="${P}">${fr ? 'Vous changez d\'idée ? Le même lien vous permet d\'en choisir un nouveau.' : 'Changed your mind? The same link lets you pick a new time.'}</p>`
      + (bookingUrl ? button(fr ? 'Choisir un moment' : 'Pick a time', bookingUrl) : '');
  } else {
    title = fr ? 'Votre rendez-vous est confirmé' : 'Your meeting is confirmed';
    body = `<p style="${P}">${hello}</p>`
      + `<p style="${P}">${fr ? `Merci ! Votre rendez-vous avec ${who} au sujet de <strong>${esc(businessName)}</strong> :` : `Thanks! Your meeting with ${who} about <strong>${esc(businessName)}</strong>:`}</p>`
      + whenBox(fr ? 'Rendez-vous' : 'Meeting', whenLabel(at, lang), { url: meetUrl, label: meetLabel(lang) })
      + `<p style="${P}">${fr ? 'Le fichier joint l\'ajoute à votre agenda. Besoin de changer ? Utilisez le bouton ci-dessous, ou répondez simplement à ce courriel.' : "The attached file adds it to your calendar. Need to change it? Use the button below, or just reply to this email."}</p>`
      + (bookingUrl ? button(fr ? 'Changer ou annuler' : 'Change or cancel', bookingUrl) : '');
  }
  if (repEmail) {
    body += `<p style="margin:18px 0 0;color:#94a3b8;font-size:12.5px">${who} · <a href="mailto:${esc(repEmail)}" style="color:#3c50e0;text-decoration:none">${esc(repEmail)}</a></p>`;
  }
  const inner = `<h1 style="margin:0 0 14px;color:#0f1722;font-size:20px;font-weight:700;line-height:1.3">${title}</h1>${body}`;
  return {
    subject: kind === 'cancelled'
      ? (fr ? 'Rendez-vous annulé — Cluster' : 'Meeting cancelled — Cluster')
      : (fr ? `Rendez-vous confirmé — ${whenLabel(at, lang)}` : `Meeting confirmed — ${whenLabel(at, lang)}`),
    html: mailChrome(inner, title, 'cluster-plain', fr ? 'fr' : 'en', home),
  };
}

// Au représentant : le client a choisi / déplacé / annulé. Bilingue, comme leadAssignedEmail.
function repChangedEmail(mailShell, { lead, at, previousAt, kind, crmLeadId, base, meetUrl }) {
  const who = [lead.contact_first_name, lead.contact_last_name].filter(Boolean).join(' ');
  const rows = [
    `<strong>${esc(lead.business_name)}</strong> — ${esc(lead.ref_code)}`,
    who ? `Contact : ${esc(who)}` : null,
    lead.contact_phone ? `Tél. : ${esc(lead.contact_phone)}` : null,
    lead.contact_email ? `Courriel : ${esc(lead.contact_email)}` : null,
    `Langue du client / Client language : <strong>${lead.language === 'en' ? 'English' : 'Français'}</strong>`,
  ].filter(Boolean).join('<br>');
  const box = kind === 'cancelled'
    ? `<div style="border-left:3px solid #dc2626;padding:10px 0 10px 14px;color:#0f1722;font-size:14px">`
      + `<strong>Le client a annulé le rendez-vous prévu ${esc(whenLabel(previousAt, 'fr') || '')}.</strong><br>`
      + `L'événement est retiré de votre Google Agenda et le rappel retiré de Zoho.<br>`
      + `<span style="color:#64748b">The client cancelled the meeting. It was removed from your Google Calendar and Zoho.</span></div>`
    : `<div style="border-left:3px solid #f97316;padding:10px 0 10px 14px;color:#0f1722;font-size:14px">`
      + `<strong>${previousAt ? 'Le client a déplacé son rendez-vous' : 'Le client a choisi son rendez-vous'} : ${esc(whenLabel(at, 'fr'))}</strong><br>`
      + (previousAt ? `<span style="color:#64748b">Avant : ${esc(whenLabel(previousAt, 'fr'))}</span><br>` : '')
      + `Votre Google Agenda et le rappel Zoho sont à jour.<br>`
      + (meetUrl ? `Google Meet : <a href="${esc(meetUrl)}" style="color:#1a73e8;text-decoration:none">${esc(meetUrl)}</a><br>` : '')
      + `<span style="color:#64748b">The client ${previousAt ? 'moved' : 'picked'} the meeting to ${esc(whenLabel(at, 'en'))}. Your calendar and Zoho are updated.</span></div>`;
  return {
    subject: kind === 'cancelled'
      ? `Rendez-vous annulé — ${lead.business_name}`
      : `${previousAt ? 'Rendez-vous déplacé' : 'Rendez-vous choisi'} — ${lead.business_name} · ${whenLabel(at, 'fr')}`,
    html: mailShell(
      kind === 'cancelled' ? 'Rendez-vous annulé / Meeting cancelled' : (previousAt ? 'Rendez-vous déplacé / Meeting moved' : 'Rendez-vous choisi / Meeting booked'),
      `${rows}<br><br>${box}`,
      'Voir la piste / View the lead',
      crmLeadId ? `https://crm.zoho.com/crm/tab/Leads/${crmLeadId}` : `${base}/leads?ref=${encodeURIComponent(lead.ref_code)}`
    ),
  };
}

// Fichier .ics « ajouter à mon agenda » (METHOD:PUBLISH : pas une invitation à accepter). Même
// UID d'un envoi à l'autre, SEQUENCE croissante : la plupart des agendas remplacent l'ancien.
function ics({ uid, at, minutes, title, description, location, organizerName, organizerEmail, sequence = 0, cancelled = false }) {
  const f = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const clean = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const end = new Date(new Date(at).getTime() + minutes * 60000);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cluster Systems//Sales Hub//FR',
    `METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}`, 'BEGIN:VEVENT',
    `UID:${uid}`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(at)}`, `DTEND:${f(end)}`, `SEQUENCE:${sequence}`,
    `SUMMARY:${clean(title)}`, `DESCRIPTION:${clean(description)}`,
    location ? `LOCATION:${clean(location)}` : null, location ? `URL:${location}` : null,
    organizerEmail ? `ORGANIZER;CN=${clean(organizerName || organizerEmail)}:mailto:${organizerEmail}` : null,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n') + '\r\n';
}

module.exports = { whenLabel, welcomeBookingBlock, clientConfirmEmail, repChangedEmail, ics };
