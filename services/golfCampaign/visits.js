// Campagne golf — rendez-vous en personne (la visite d'un club), réservés pendant l'appel.
//
// Le visiteur (par défaut David) a UN agenda : Google Agenda par le compte de service déjà utilisé par
// les rendez-vous des pistes (services/leadBooking). Le représentant qui appelle voit les créneaux libres
// de CE visiteur, en choisit un ; l'événement est créé dans son agenda, le club reçoit un courriel avec
// un fichier .ics (au nom du visiteur) et le visiteur reçoit le détail par courriel.
//
// 🔑 Disponibilité = Google libre/occupé + visites déjà prises dans Sales Hub pour ce visiteur. Sans
// Google configuré, seule la seconde source compte — la réponse le dit (`source`), pour qu'on ne croie
// pas l'agenda lu alors qu'il ne l'est pas.
// 🔑 La course : deux représentants qui choisissent le même créneau. La vérification de conflit est DANS
// l'UPDATE (un seul ordre SQL) : le second reçoit 409 `slot_taken`.
const crypto = require('crypto');
const G = require('../leadBooking/googleCalendar');
const S = require('../leadBooking/slots');
const E = require('../leadBooking/emails');

const TZ = 'America/Toronto';
const VISITOR_KEY = 'golf_campaign_visitor';
const DEFAULT_VISITOR = { email: 'david@clustersystems.com', name: 'David', slotMinutes: 60 };
const MAX_NOTE = 1000;

const clean = (v, max) => String(v == null ? '' : v).replace(/[\r\n"<>]/g, ' ').trim().slice(0, max);

function registerVisitRoutes(app, { use, manage, pool, sendMail, mailShell, base }) {
  const baseUrl = () => (base ? base() : process.env.FRONTEND_URL || 'https://saleshub.clusterpos.com');

  async function getVisitor() {
    let v = {};
    try {
      const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [VISITOR_KEY]);
      v = (rows[0] && rows[0].value) || {};
    } catch { /* défauts */ }
    return {
      email: String(v.email || DEFAULT_VISITOR.email).toLowerCase(),
      name: v.name || DEFAULT_VISITOR.name,
      slotMinutes: Math.min(240, Math.max(15, Number(v.slotMinutes) || DEFAULT_VISITOR.slotMinutes)),
    };
  }

  async function slotsFor(visitor, clubId, current) {
    const now = new Date();
    const days = 7;
    const w = S.window({ now, days, tz: TZ });
    const minutes = visitor.slotMinutes;
    const busy = [];
    let source = 'saleshub', googleError = null;
    try {
      const r = await pool.query(
        `SELECT meeting_at FROM golf_clubs
          WHERE LOWER(meeting_with) = LOWER($1) AND id <> $2 AND meeting_at IS NOT NULL AND meeting_at BETWEEN $3 AND $4`,
        [visitor.email, clubId, new Date(now.getTime() - 4 * 3600000).toISOString(), w.timeMax.toISOString()]);
      for (const row of r.rows) {
        const s = new Date(row.meeting_at);
        busy.push({ start: s, end: new Date(s.getTime() + minutes * 60000) });
      }
    } catch (e) { console.warn('[golf] visites illisibles :', e.message); }
    if (G.configured()) {
      try { busy.push(...await G.freeBusy(visitor.email, w.timeMin, w.timeMax)); source = 'google'; } catch (e) { googleError = e.message.slice(0, 300); }
    }
    const list = S.computeSlots({
      now, busy, days, slotMinutes: minutes, minNoticeHours: 2, businessHours: { start: 9, end: 17 }, tz: TZ,
      exclude: current ? { start: new Date(current), end: new Date(new Date(current).getTime() + minutes * 60000) } : null,
    });
    return { days: list, source, googleError };
  }

  function eventBody(club, visitor, at, note, userEmail) {
    return {
      summary: `Visite — ${club.name}`.slice(0, 250),
      location: club.address || undefined,
      description: [
        `Visite en personne — Campagne golf (Sales Hub).`,
        club.contact_name ? `Contact : ${club.contact_name}` : null,
        club.phone ? `Tél. : ${club.phone}` : null,
        club.email ? `Courriel : ${club.email}` : null,
        club.gg_directory_name ? `Plateforme actuelle : GGGolf (migration vers Lightspeed)` : null,
        note ? `Note : ${note}` : null,
        userEmail ? `Réservé par : ${userEmail}` : null,
        '',
        `Fiche : ${baseUrl()}/golf-campaign`,
      ].filter((l) => l !== null).join('\n'),
      start: { dateTime: new Date(at).toISOString(), timeZone: TZ },
      end: { dateTime: new Date(new Date(at).getTime() + visitor.slotMinutes * 60000).toISOString(), timeZone: TZ },
      extendedProperties: { private: { salesHubGolfClub: String(club.id) } },
      reminders: { useDefault: true },
    };
  }

  async function upsertEvent(club, visitor, at, note, userEmail) {
    if (!G.configured()) return { ok: false, skipped: 'google_not_configured' };
    try {
      const body = eventBody(club, visitor, at, note, userEmail);
      if (club.gcal_event_id && String(club.gcal_calendar || '').toLowerCase() === visitor.email) {
        const p = await G.patchEvent(visitor.email, club.gcal_event_id, body);
        if (p.ok) return { ok: true, id: club.gcal_event_id, moved: true };
        if (!p.gone) return { ok: false, error: p.error };
      }
      const r = await G.insertEvent(visitor.email, body);
      return r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error };
    } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
  }

  // L'expéditeur : le visiteur lui-même si son domaine est authentifié (même règle que les rendez-vous des pistes).
  function senderFor(visitor) {
    const verified = String(process.env.HR_SENDER_DOMAINS || 'clustersystems.com').split(',')
      .map((d) => d.trim().toLowerCase()).filter((d) => d && d !== 'none');
    if (verified.includes(visitor.email.split('@')[1] || '')) return { from: `"${clean(visitor.name, 80)}" <${visitor.email}>`, replyTo: visitor.email };
    return { replyTo: visitor.email };
  }

  const escHtml = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Le texte PAR DÉFAUT du courriel au club, en texte brut : c'est lui que le représentant peut corriger
  // dans la fenêtre d'aperçu avant l'envoi.
  function clubText(club, visitor, at, lang, cancelled) {
    const en = lang === 'en';
    const when = E.whenLabel(at, en ? 'en' : 'fr');
    const first = club.contact_name ? club.contact_name.split(' ')[0] : '';
    const hello = en ? `Hello ${first},` : `Bonjour ${first},`;
    const where = club.address ? (en ? `\nLocation: ${clean(club.address, 300)}` : `\nLieu : ${clean(club.address, 300)}`) : '';
    const text = cancelled
      ? (en ? `${hello}\n\nYour meeting with ${visitor.name} (Cluster) planned for ${when} is cancelled. We'll be in touch to find another time.`
        : `${hello}\n\nVotre rendez-vous avec ${visitor.name} (Cluster) prévu le ${when} est annulé. Nous vous recontactons pour trouver un autre moment.`)
      : (en ? `${hello}\n\nThanks for your time on the phone. Your in-person meeting with ${visitor.name} (Cluster) is confirmed for ${when}.${where}\n\nWe'll show you how Cluster can replace what GGGolf does for you, while you keep everything else as it is today. To change the time, just reply to this email.`
        : `${hello}\n\nMerci du temps accordé au téléphone. Votre rendez-vous en personne avec ${visitor.name} (Cluster) est confirmé le ${when}.${where}\n\nNous vous montrerons comment Cluster peut remplacer ce que GGGolf fait pour vous, tout en gardant le reste comme aujourd'hui. Pour changer l'heure, répondez simplement à ce courriel.`);
    return {
      when, text,
      title: cancelled ? (en ? 'Meeting cancelled' : 'Rendez-vous annulé') : (en ? 'Meeting confirmed' : 'Rendez-vous confirmé'),
      subject: cancelled ? (en ? `Meeting cancelled — Cluster` : `Rendez-vous annulé — Cluster`) : (en ? `Meeting confirmed — Cluster, ${when}` : `Rendez-vous confirmé — Cluster, ${when}`),
    };
  }

  // `ov` = { subject, message } corrigés par le représentant. Le texte est TOUJOURS échappé : le HTML du
  // courriel est fabriqué ici, jamais reçu du navigateur.
  function clubMail(club, visitor, at, lang, cancelled, ov = {}) {
    const d = clubText(club, visitor, at, lang, cancelled);
    const subject = ov.subject || d.subject;
    const text = ov.message || d.text;
    const body = escHtml(text).split(escHtml(d.when)).join(`<strong>${escHtml(d.when)}</strong>`).replace(/\r?\n/g, '<br>');
    return { subject, text, defaultSubject: d.subject, defaultText: d.text, html: mailShell(d.title, body, undefined, undefined, lang === 'en' ? 'en' : 'fr') };
  }
  const overridesOf = (b) => ({
    subject: clean(b && b.subject, 200) || undefined,
    message: String((b && b.message) || '').replace(/\r\n/g, '\n').trim().slice(0, 2000) || undefined,
  });

  // Tout ce qui partira, composé UNE fois : l'aperçu montre exactement ce que l'envoi enverra.
  function composeMails(club, visitor, at, lang, note, bookerEmail, notify, ov = {}) {
    const when = E.whenLabel(at, 'fr');
    const toClub = notify && club.email ? club.email.split(/[\/;,]/)[0].trim() : null;
    const cm = toClub ? clubMail(club, visitor, at, lang, false, ov) : null;
    const sender = senderFor(visitor);
    const client = cm ? { to: toClub, from: sender.from || null, replyTo: sender.replyTo || null, subject: cm.subject, text: cm.text, defaultSubject: cm.defaultSubject, defaultText: cm.defaultText, html: cm.html, attachment: lang === 'en' ? 'meeting.ics' : 'rendez-vous.ics' } : null;
    const visitorMail = {
      to: visitor.email, subject: `Visite planifiée — ${club.name} · ${when}`,
      html: mailShell(`Visite planifiée — ${club.name}`,
        `<strong>${when}</strong>${club.address ? `<br>${clean(club.address, 300)}` : ''}${club.contact_name ? `<br>Contact : ${clean(club.contact_name, 200)}` : ''}${club.phone ? `<br>Tél. : ${clean(club.phone, 60)}` : ''}${club.email ? `<br>Courriel : ${clean(club.email, 200)}` : ''}<br>Réservé par : ${clean(bookerEmail, 200)}${note ? `<br>Note : ${note}` : ''}`,
        'Ouvrir la campagne golf', `${baseUrl()}/golf-campaign`, 'fr'),
    };
    const ev = eventBody(club, visitor, at, note, bookerEmail);
    return { client, visitor: visitorMail, event: { summary: ev.summary, when, location: ev.location || null, description: ev.description, calendar: visitor.email, minutes: visitor.slotMinutes } };
  }

  const icsFor = (club, visitor, at, lang, cancelled, seq) => E.ics({
    uid: `golf-${club.id}@saleshub.clusterpos.com`, at, minutes: visitor.slotMinutes, sequence: seq, cancelled,
    title: lang === 'en' ? `Meeting with ${visitor.name} — Cluster` : `Rendez-vous avec ${visitor.name} — Cluster`,
    description: lang === 'en' ? `In-person meeting with ${visitor.name} (Cluster).` : `Rendez-vous en personne avec ${visitor.name} (Cluster).`,
    location: club.address || '', organizerName: visitor.name, organizerEmail: visitor.email,
  });

  // ── Routes ────────────────────────────────────────────────────────────────
  app.get('/api/golf-campaign/visitor', ...use, async (req, res) => {
    try { res.json({ visitor: await getVisitor(), calendarConnected: G.configured() }); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/golf-campaign/visitor', ...manage, async (req, res) => {
    try {
      const b = req.body || {};
      const email = String(b.email || '').trim().toLowerCase();
      const name = clean(b.name, 80);
      const slotMinutes = Number(b.slotMinutes);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name || !(slotMinutes >= 15 && slotMinutes <= 240)) return res.status(400).json({ error: 'invalid' });
      const value = { email, name, slotMinutes: Math.round(slotMinutes) };
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [VISITOR_KEY, JSON.stringify(value)]);
      res.json({ visitor: await getVisitor() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/golf-campaign/clubs/:id/slots', ...use, async (req, res) => {
    try {
      const club = (await pool.query('SELECT id, meeting_at FROM golf_clubs WHERE id = $1', [req.params.id])).rows[0];
      if (!club) return res.status(404).json({ error: 'not_found' });
      const visitor = await getVisitor();
      const r = await slotsFor(visitor, club.id, club.meeting_at);
      res.json({ visitor, slotMinutes: visitor.slotMinutes, days: r.days, source: r.source, googleError: r.googleError });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Aperçu : valide le créneau comme la réservation, ne modifie rien, n'envoie rien.
  app.post('/api/golf-campaign/clubs/:id/meeting/preview', ...use, async (req, res) => {
    try {
      const at = new Date(req.body && req.body.at);
      if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now()) return res.status(400).json({ error: 'invalid_time' });
      const lang = req.body.lang === 'en' ? 'en' : 'fr';
      const note = clean(req.body.note, MAX_NOTE);
      const club = (await pool.query('SELECT * FROM golf_clubs WHERE id = $1', [req.params.id])).rows[0];
      if (!club) return res.status(404).json({ error: 'not_found' });
      const visitor = await getVisitor();
      const cur = club.meeting_at ? new Date(club.meeting_at) : null;
      if (!(cur && cur.getTime() === at.getTime())) {
        const r = await slotsFor(visitor, club.id, cur);
        if (!r.days.some((d) => d.slots.includes(at.toISOString()))) return res.status(409).json({ error: 'slot_taken' });
      }
      const mails = composeMails(club, visitor, at, lang, note, String(req.user.email || '').toLowerCase(), req.body.notify !== false, overridesOf(req.body));
      res.json({ ...mails, moving: !!cur, calendarConnected: G.configured(), noClubEmail: !club.email });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/golf-campaign/clubs/:id/meeting', ...use, async (req, res) => {
    try {
      const at = new Date(req.body && req.body.at);
      if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now()) return res.status(400).json({ error: 'invalid_time' });
      const lang = req.body.lang === 'en' ? 'en' : 'fr';
      const note = clean(req.body.note, MAX_NOTE);
      const club = (await pool.query('SELECT * FROM golf_clubs WHERE id = $1', [req.params.id])).rows[0];
      if (!club) return res.status(404).json({ error: 'not_found' });
      const visitor = await getVisitor();

      const cur = club.meeting_at ? new Date(club.meeting_at) : null;
      const same = cur && cur.getTime() === at.getTime();
      if (!same) {
        const r = await slotsFor(visitor, club.id, cur);
        if (!r.days.some((d) => d.slots.includes(at.toISOString()))) return res.status(409).json({ error: 'slot_taken' });
      }
      const email = String(req.user.email || '').toLowerCase();
      // Verrou : un seul ordre SQL vérifie qu'aucune autre visite du même visiteur ne chevauche, puis réserve.
      const up = await pool.query(
        `UPDATE golf_clubs SET meeting_at = $2, meeting_with = $3, status = 'meeting', callback_at = NULL,
                last_call_at = NOW(), updated_at = NOW(), assigned_to = COALESCE(assigned_to, $5)
          WHERE id = $1 AND NOT EXISTS (
            SELECT 1 FROM golf_clubs o WHERE o.id <> $1 AND LOWER(o.meeting_with) = LOWER($3) AND o.meeting_at IS NOT NULL
              AND o.meeting_at < $2::timestamptz + make_interval(mins => $4::int)
              AND o.meeting_at + make_interval(mins => $4::int) > $2::timestamptz)
          RETURNING *`,
        [club.id, at.toISOString(), visitor.email, visitor.slotMinutes, email]);
      if (!up.rows.length) return res.status(409).json({ error: 'slot_taken' });

      const calendar = await upsertEvent(club, visitor, at, note, email);
      if (calendar.ok) {
        await pool.query('UPDATE golf_clubs SET gcal_event_id = $2, gcal_calendar = $3 WHERE id = $1', [club.id, calendar.id, visitor.email]);
      }
      const label = E.whenLabel(at, 'fr');
      await pool.query(
        'INSERT INTO golf_call_log (id, club_id, by_email, outcome, note) VALUES ($1,$2,$3,$4,$5)',
        [crypto.randomUUID(), club.id, email, 'meeting',
          `${same ? 'Visite confirmée' : (cur ? 'Visite déplacée' : 'Visite planifiée')} : ${label} avec ${visitor.name}${note ? ` — ${note}` : ''}`]);

      const fresh = (await pool.query('SELECT * FROM golf_clubs WHERE id = $1', [club.id])).rows[0];
      let clientMail = { sent: false, reason: 'not_requested' };
      const composed = composeMails(club, visitor, at, lang, note, email, req.body.notify !== false, overridesOf(req.body));
      if (composed.client && sendMail) {
        const seq = Math.floor(Date.now() / 1000);
        clientMail = await sendMail(composed.client.to, composed.client.subject, composed.client.html, {
          ...senderFor(visitor),
          attachments: [{ filename: composed.client.attachment, content: Buffer.from(icsFor(club, visitor, at, lang, false, seq)), contentType: 'text/calendar; charset=utf-8' }],
        });
      } else if (!club.email) clientMail = { sent: false, reason: 'no_club_email' };
      let visitorMail = { sent: false, reason: 'no_mailer' };
      if (sendMail && !same) visitorMail = await sendMail(composed.visitor.to, composed.visitor.subject, composed.visitor.html);
      res.json({ club: fresh, calendar, clientMail, visitorMail, visitor });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function loadCancelContext(req, res) {
    const club = (await pool.query('SELECT * FROM golf_clubs WHERE id = $1', [req.params.id])).rows[0];
    if (!club) { res.status(404).json({ error: 'not_found' }); return null; }
    if (!club.meeting_at) { res.status(409).json({ error: 'no_meeting' }); return null; }
    const current = await getVisitor();
    const visitor = { ...current, email: String(club.meeting_with || current.email).toLowerCase() };
    return { club, visitor, at: new Date(club.meeting_at) };
  }

  // Aperçu de l'annulation : ne retire rien, n'envoie rien.
  app.post('/api/golf-campaign/clubs/:id/meeting/cancel/preview', ...use, async (req, res) => {
    try {
      const ctx = await loadCancelContext(req, res);
      if (!ctx) return;
      const { club, visitor, at } = ctx;
      const lang = req.body && req.body.lang === 'en' ? 'en' : 'fr';
      const toClub = club.email ? club.email.split(/[\/;,]/)[0].trim() : null;
      const sender = senderFor(visitor);
      let client = null;
      if (toClub) {
        const m = clubMail(club, visitor, at, lang, true, overridesOf(req.body));
        client = { to: toClub, from: sender.from || null, replyTo: sender.replyTo || null, subject: m.subject, text: m.text, defaultSubject: m.defaultSubject, defaultText: m.defaultText, html: m.html, attachment: 'cancel.ics' };
      }
      res.json({ client, noClubEmail: !club.email, when: E.whenLabel(at, 'fr'), calendarConnected: G.configured(), event: { summary: `Visite — ${club.name}`, calendar: visitor.email } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function cancelMeeting(req, res, { notify, lang, ov }) {
    const ctx = await loadCancelContext(req, res);
    if (!ctx) return;
    const { club, visitor, at } = ctx;
    let calendar = { ok: true, skipped: 'none' };
    if (club.gcal_event_id && G.configured()) {
      try { calendar = await G.deleteEvent(String(club.gcal_calendar || visitor.email), club.gcal_event_id); } catch (e) { calendar = { ok: false, error: e.message.slice(0, 300) }; }
    }
    const email = String(req.user.email || '').toLowerCase();
    const up = await pool.query(
      `UPDATE golf_clubs SET meeting_at = NULL, meeting_with = NULL, gcal_event_id = NULL, gcal_calendar = NULL,
              status = 'interested', updated_at = NOW() WHERE id = $1 RETURNING *`, [club.id]);
    await pool.query('INSERT INTO golf_call_log (id, club_id, by_email, outcome, note) VALUES ($1,$2,$3,$4,$5)',
      [crypto.randomUUID(), club.id, email, 'interested', `Visite annulée (était le ${E.whenLabel(at, 'fr')})`]);
    let clientMail = { sent: false, reason: 'not_requested' };
    if (notify && club.email && sendMail) {
      const m = clubMail(club, visitor, at, lang, true, ov);
      clientMail = await sendMail(club.email.split(/[\/;,]/)[0].trim(), m.subject, m.html, {
        ...senderFor(visitor),
        attachments: [{ filename: 'cancel.ics', content: Buffer.from(icsFor(club, visitor, at, lang, true, Math.floor(Date.now() / 1000))), contentType: 'text/calendar; charset=utf-8' }],
      });
    }
    res.json({ club: up.rows[0], calendar, clientMail });
  }

  app.post('/api/golf-campaign/clubs/:id/meeting/cancel', ...use, async (req, res) => {
    try {
      await cancelMeeting(req, res, { notify: req.body.notify !== false, lang: req.body.lang === 'en' ? 'en' : 'fr', ov: overridesOf(req.body) });
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
  });

  // Ancienne forme, gardée : mêmes effets, texte par défaut.
  app.delete('/api/golf-campaign/clubs/:id/meeting', ...use, async (req, res) => {
    try {
      await cancelMeeting(req, res, { notify: req.query.notify !== '0', lang: req.query.lang === 'en' ? 'en' : 'fr', ov: {} });
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
  });
}

module.exports = { registerVisitRoutes, DEFAULT_VISITOR };
