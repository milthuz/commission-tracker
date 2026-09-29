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

// Quand le représentant rappellera, en mots : « d'ici une heure » / « d'ici deux heures » quand
// c'est vrai ; sinon le jour et l'heure (piste acceptée après les heures ouvrables : le rappel
// tombe à la prochaine ouverture, et promettre « d'ici une heure » serait faux).
function callbackPhrase(at, lang, now = Date.now()) {
  if (!at) return null;
  const fr = lang !== 'en';
  const mins = (new Date(at).getTime() - now) / 60000;
  if (mins <= 65) return fr ? "d'ici une heure" : 'within the hour';
  if (mins <= 125) return fr ? "d'ici deux heures" : 'within two hours';
  const loc = fr ? 'fr-CA' : 'en-CA';
  const day = new Date(at).toLocaleDateString(loc, { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const hm = new Date(at).toLocaleTimeString(loc, { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  return fr ? `le ${day} vers ${hm}` : `on ${day} around ${hm}`;
}
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

// ── Le courriel de BIENVENUE au marchand (refonte du 2026-09-28, maquette approuvée par David) ──
// Carte du conseiller (initiales, titre et téléphone de sa SIGNATURE de profil), rendez-vous au
// format « calendrier » avec Google Meet, les 3 prochaines étapes (textes validés par David), et la
// signature officielle Cluster du représentant (buildSignatureHtml, la même que les propositions).
// Tout en TABLEAUX et styles en ligne : Outlook ignore flexbox et la plupart des feuilles de style.
//   rep : { name, email, role, phone }          — role/phone viennent de salespeople.signature_*
//   at  : Date | null — l'heure proposée ; null = aucun rendez-vous planifié
//   signatureHtml : '' quand le représentant n'a pas configuré sa signature
// MÉCANIQUE DU 2026-09-29 (décision de David) : à l'acceptation, le représentant RAPPELLE le client
// d'ici une heure — `callbackAt` + `clientPhone`. Le courriel l'annonce et offre de choisir une
// autre plage si ce n'est pas un bon moment ; c'est seulement alors qu'un rendez-vous (Google
// Agenda + Meet) est créé. `at` (rendez-vous déjà fixé) reste géré pour les autres usages.
function welcomeEmail(mailChrome, { lang, firstName, businessName, rep, at, callbackAt = null, clientPhone = null, minutes = 30, bookingUrl, meetUrl, home, signatureHtml, now = Date.now() }) {
  const fr = lang !== 'en';
  const repName = rep?.name || null;
  const initials = (repName || 'C').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const T = (a, b) => (fr ? a : b);

  const title = firstName
    ? T(`Bonjour ${esc(firstName)}, votre demande est entre bonnes mains`, `Hi ${esc(firstName)}, your request is in good hands`)
    : T('Bonjour, votre demande est entre bonnes mains', 'Hello, your request is in good hands');
  const intro = T(
    `Merci d'avoir pensé à nous pour <strong style="color:#0f1722">${esc(businessName)}</strong>. Une vraie personne, pas une file d'attente, s'occupe maintenant de votre dossier.`,
    `Thanks for thinking of us for <strong style="color:#0f1722">${esc(businessName)}</strong>. A real person, not a queue, is now looking after your request.`);

  // Carte du conseiller.
  const repCard = repName ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;border:1px solid #e2e8f0;border-radius:12px">
      <tr>
        <td width="76" style="padding:14px 0 14px 16px;vertical-align:middle">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" style="width:48px;height:48px;border-radius:24px;background:#fff1e8;color:#c2410c;font-weight:700;font-size:16px">${esc(initials)}</td></tr></table>
        </td>
        <td style="padding:14px 16px 14px 0;vertical-align:middle">
          <div style="font-weight:700;font-size:15px;color:#0f1722">${esc(repName)}</div>
          <div style="font-size:12.5px;color:#64748b">${esc(rep.role || T('Votre conseiller', 'Your advisor'))} · Cluster</div>
          ${rep.email ? `<div style="font-size:13px;margin-top:2px"><a href="mailto:${esc(rep.email)}" style="color:#3c50e0;text-decoration:none">${esc(rep.email)}</a></div>` : ''}
          ${rep.phone ? `<div style="font-size:13px;margin-top:1px"><a href="tel:${esc(String(rep.phone).replace(/[^\d+]/g, ''))}" style="color:#0f1722;text-decoration:none">${esc(rep.phone)}</a></div>` : ''}
        </td>
      </tr>
    </table>` : '';

  // Le rendez-vous, au format calendrier.
  let appt = '';
  if (at) {
    const loc = fr ? 'fr-CA' : 'en-CA';
    const part = (o) => new Date(at).toLocaleString(loc, { timeZone: TZ, ...o });
    const end = new Date(new Date(at).getTime() + minutes * 60000);
    const hm = (d) => new Date(d).toLocaleTimeString(loc, { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    appt = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border:1px solid #fed7aa;border-radius:12px;border-collapse:separate">
      <tr>
        <td width="84" align="center" style="background:#f97316;color:#ffffff;padding:12px 0;border-radius:11px 0 0 11px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px">${esc(part({ month: 'short' }))}</div>
          <div style="font-size:30px;font-weight:700;line-height:1.1">${esc(part({ day: 'numeric' }))}</div>
          <div style="font-size:11px">${esc(part({ weekday: 'long' }))}</div>
        </td>
        <td style="background:#fff7ed;padding:12px 16px;border-radius:0 11px 11px 0">
          <div style="font-size:17px;font-weight:700;color:#0f1722">${esc(hm(at))} – ${esc(hm(end))}</div>
          <div style="font-size:12.5px;color:#9a3412;margin-top:2px">${T(`Premier rendez-vous · ${minutes} minutes · heure de Montréal`, `First meeting · ${minutes} minutes · Montreal time`)}</div>
        </td>
      </tr>
    </table>`;
  }
  // Le rappel annoncé (pas de rendez-vous fixé) : seulement si le client a laissé un téléphone.
  const callbackWhen = !at && callbackAt && clientPhone ? callbackPhrase(callbackAt, lang, now) : null;
  if (callbackWhen) {
    const whoFull = repName ? esc(repName) : T('Votre conseiller', 'Your advisor');
    appt = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border:1px solid #fed7aa;border-radius:12px;border-collapse:separate">
      <tr>
        <td width="84" align="center" style="background:#f97316;color:#ffffff;padding:14px 0;border-radius:11px 0 0 11px;font-size:26px;line-height:1">&#9742;</td>
        <td style="background:#fff7ed;padding:12px 16px;border-radius:0 11px 11px 0">
          <div style="font-size:17px;font-weight:700;color:#0f1722">${T(`Appel prévu ${esc(callbackWhen)}`, `We'll call you ${esc(callbackWhen)}`)}</div>
          <div style="font-size:13px;color:#9a3412;margin-top:3px">${T(`${whoFull} vous appellera au ${esc(clientPhone)}.`, `${whoFull} will call you at ${esc(clientPhone)}.`)}</div>
        </td>
      </tr>
    </table>`;
  }
  const btn = (label, url, primary) => `<td style="padding:0 8px 8px 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:9px;${primary ? 'background:#1a73e8' : 'background:#ffffff;border:1px solid #cbd5e1'}">
      <a href="${esc(url)}" style="display:inline-block;padding:${primary ? '11px 18px' : '10px 16px'};font-size:13.5px;font-weight:700;text-decoration:none;color:${primary ? '#ffffff' : '#0f1722'};border-radius:9px">${label}</a>
    </td></tr></table></td>`;
  const buttons = [
    at && meetUrl ? btn(T('Rejoindre par Google Meet', 'Join with Google Meet'), meetUrl, true) : '',
    bookingUrl ? btn(
      callbackWhen ? T('Choisir une autre plage', 'Pick another time')
        : at ? T('Choisir un autre moment', 'Pick another time') : T('Choisir un moment', 'Pick a time'),
      bookingUrl, !(at && meetUrl)) : '',
  ].join('');
  const actions = buttons ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 0"><tr>${buttons}</tr></table>` : '';
  const who = repName ? esc(repName.split(/\s+/)[0]) : T('votre conseiller', 'your advisor');
  const note = callbackWhen
    ? `<p style="margin:6px 0 20px;font-size:12.5px;color:#94a3b8;line-height:1.6">${T(
        `Ce n'est pas un bon moment ? Choisissez une plage qui vous convient : ${who} vous rencontrera alors par Google Meet ou par téléphone. Vous pouvez aussi répondre directement à ce courriel.`,
        `Not a good time? Pick a slot that suits you: ${who} will then meet you by Google Meet or by phone. You can also just reply to this email.`)}</p>`
    : at
    ? `<p style="margin:6px 0 20px;font-size:12.5px;color:#94a3b8;line-height:1.6">${T(
        `Le fichier joint l'ajoute à votre agenda. Vous préférez le téléphone ? Répondez simplement à ce courriel, ${who} vous appellera.`,
        `The attached file adds it to your calendar. Prefer the phone? Just reply to this email and ${who} will call you.`)}</p>`
    : `<p style="margin:6px 0 20px;font-size:12.5px;color:#94a3b8;line-height:1.6">${T(
        `${repName ? esc(repName) : 'Votre conseiller'} vous contactera sous peu. Vous pouvez aussi répondre directement à ce courriel.`,
        `${repName ? esc(repName) : 'Your advisor'} will be in touch shortly. You can also just reply to this email.`)}</p>`;

  // Les 3 prochaines étapes (textes validés par David le 2026-09-28).
  const step = (n, t, d) => `<tr><td width="36" style="vertical-align:top;padding:0 0 12px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" style="width:24px;height:24px;border-radius:12px;background:#0f1722;color:#ffffff;font-size:12px;font-weight:700">${n}</td></tr></table>
    </td><td style="vertical-align:top;padding:0 0 12px">
      <div style="font-size:14px;font-weight:700;color:#0f1722">${t}</div>
      <div style="font-size:13px;color:#64748b;line-height:1.5">${d}</div>
    </td></tr>`;
  const biz = esc(businessName);
  const steps = `
    <div style="border-top:1px solid #eef1f6;padding-top:16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${step(1, T('On fait connaissance', "Let's get to know you"),
          T(`${who.charAt(0).toUpperCase() + who.slice(1)} apprend comment roule ${biz} : vos services, votre équipe, ce qui vous ralentit.`,
            `${who.charAt(0).toUpperCase() + who.slice(1)} learns how ${biz} runs: your services, your team, what slows you down.`))}
        ${step(2, T('Une proposition sur mesure', 'A tailored proposal'),
          T('Le bon système et les bons tarifs pour vous, sans surprise.', 'The right system and the right rates for you, with no surprises.'))}
        ${step(3, T('On vous installe', 'We get you set up'),
          T("Installation, migration et formation de votre équipe, avec un suivi après le lancement.", 'Installation, migration and training for your team, with follow-up after launch.'))}
      </table>
    </div>`;

  const dayWord = at ? new Date(at).toLocaleString(fr ? 'fr-CA' : 'en-CA', { timeZone: TZ, weekday: 'long' }) : null;
  const signOff = `<p style="margin:18px 0 0;font-size:14.5px;color:#475569;line-height:1.6">${
    at ? T(`Au plaisir de vous parler ${esc(dayWord)},`, `Looking forward to speaking with you on ${esc(dayWord)},`)
      : callbackWhen ? T('Au plaisir de vous parler très bientôt,', 'Talk to you very soon,') : T('Au plaisir,', 'Talk soon,')}</p>`
    + (signatureHtml || `<p style="margin:6px 0 0;font-size:14.5px;line-height:1.6"><strong style="color:#0f1722">${esc(repName || 'Cluster')}</strong><br><span style="color:#475569">Cluster</span></p>`);

  const inner = `
    <p style="margin:0 0 6px;color:#c2410c;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase">${T('Bienvenue chez Cluster', 'Welcome to Cluster')}</p>
    <h1 style="margin:0 0 10px;color:#0f1722;font-size:22px;font-weight:700;line-height:1.3">${title}</h1>
    <p style="${P}">${intro}</p>
    ${repCard}${appt}${actions}${note}${steps}${signOff}`;

  return {
    subject: T(`Bienvenue chez Cluster — votre demande pour ${businessName}`, `Welcome to Cluster — your request for ${businessName}`),
    html: mailChrome(inner, title.replace(/<[^>]+>/g, ''), 'cluster-plain', fr ? 'fr' : 'en', home, rep?.email || null),
  };
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
// `replacedCallbackAt` : le client a choisi une plage au lieu du rappel « d'ici une heure ».
function repChangedEmail(mailShell, { lead, at, previousAt, kind, crmLeadId, base, meetUrl, replacedCallbackAt = null }) {
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
      + (replacedCallbackAt ? `<span style="color:#64748b">Au lieu de l'appel prévu ${esc(whenLabel(replacedCallbackAt, 'fr'))} : ne l'appelez pas avant l'heure choisie.</span><br>` : '')
      + `Votre Google Agenda et le rappel Zoho sont à jour.<br>`
      + (meetUrl ? `Google Meet : <a href="${esc(meetUrl)}" style="color:#1a73e8;text-decoration:none">${esc(meetUrl)}</a><br>` : '')
      + `<span style="color:#64748b">${previousAt ? 'The client moved the meeting to' : 'The client booked a meeting for'} ${esc(whenLabel(at, 'en'))}${replacedCallbackAt ? " instead of the scheduled call: don't call before then" : ''}. Your calendar and Zoho are updated.</span></div>`;
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

module.exports = { whenLabel, callbackPhrase, welcomeBookingBlock, welcomeEmail, clientConfirmEmail, repChangedEmail, ics };
