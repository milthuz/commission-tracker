// ============================================================================
// Rendez-vous des pistes — le marchand choisit, change ou annule son appel.
//
// Monté par UNE ligne dans server.js (comme services/hr) ; acceptLead() appelle les aides
// exportées ci-dessous.
//
// Le parcours :
//   acceptation ─▶ heure PROPOSÉE = 1er créneau libre du représentant après le délai configuré
//              ─▶ rappel Zoho + événement dans le Google Agenda du représentant
//              ─▶ courriel de bienvenue (DE : le représentant, langue du client) + lien /rdv
//   /rdv?token ─▶ créneaux libres (Google libre/occupé + rendez-vous déjà pris dans Sales Hub)
//              ─▶ choisir / confirmer / annuler : Zoho et Google suivent, deux courriels partent
//
// 🔑 LE LIEN. Jeton aléatoire de 32 octets, seul son SHA-256 est en base (même modèle que la
// signature RH). Il reste valable BOOKING_LINK_DAYS jours après l'acceptation et tant que la piste
// est acceptée ; un rendez-vous passé ne se déplace plus depuis le lien.
//
// 🔑 LA DISPONIBILITÉ a deux sources, additionnées : le Google Agenda (si le compte de service est
// configuré) ET les rendez-vous déjà pris dans Sales Hub pour ce représentant. Sans Google, la page
// fonctionne quand même sur la seconde seule — dite « saleshub » dans `source`, et visible dans
// l'écran de la piste, pour qu'on ne croie pas l'agenda lu alors qu'il ne l'est pas.
//
// 🔑 LA COURSE. Deux marchands qui cliquent le même créneau du même représentant : un verrou
// consultatif Postgres par représentant sérialise « vérifier puis réserver ».
// ============================================================================

const crypto = require('crypto');
const axios = require('axios');
const G = require('./googleCalendar');
const S = require('./slots');
const E = require('./emails');

const BOOKING_LINK_DAYS = 30;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function registerLeadBookingRoutes(app, deps) {
  const { authenticateToken, requirePerm, pool, logActivity, rateLimited, sendMail, mailChrome, mailShell, ensureValidCrmToken } = deps;
  // Ce qui vit dans server.js et y est défini PLUS BAS que la ligne de montage : lu à l'appel.
  const h = () => deps.late();
  const base = () => process.env.FRONTEND_URL || 'https://saleshub.clusterpos.com';
  const TZ = 'America/Toronto';

  // ── Schéma ────────────────────────────────────────────────────────────────
  // Ici plutôt que dans initializeDatabase() : la table `leads` y est créée dans le grand
  // try/catch, et une colonne en plus ne doit rien pouvoir y casser. Réessayé au premier usage si
  // le démarrage est passé avant que `leads` existe (base neuve).
  let schemaReady = null;
  function ensureSchema() {
    if (!schemaReady) {
      schemaReady = (async () => {
        await pool.query(`
          ALTER TABLE leads
            ADD COLUMN IF NOT EXISTS booking_token_hash  VARCHAR(64),
            ADD COLUMN IF NOT EXISTS booking_status      VARCHAR(20),
            ADD COLUMN IF NOT EXISTS booking_updated_at  TIMESTAMP,
            ADD COLUMN IF NOT EXISTS booking_changes     INT NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS gcal_event_id       VARCHAR(255),
            ADD COLUMN IF NOT EXISTS gcal_calendar       VARCHAR(255),
            ADD COLUMN IF NOT EXISTS gcal_meet_url       VARCHAR(300)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_leads_booking_token ON leads(booking_token_hash)`);
      })().catch((e) => { schemaReady = null; throw e; });
    }
    return schemaReady;
  }
  setTimeout(() => ensureSchema().catch((e) => console.warn('[rdv] schéma pas encore prêt :', e.message)), 15000);

  // ── Expéditeur : le représentant lui-même ─────────────────────────────────
  // Même règle que les courriels RH (services/hr/routes.js, senderOpts) : écrire « De : sophie@… »
  // n'est accepté par SendGrid que si le domaine est authentifié. HR_SENDER_DOMAINS liste ces
  // domaines (défaut clustersystems.com, confirmé le 2026-09-23). Hors liste : le nom du
  // représentant sur l'adresse d'envoi habituelle, et la réponse qui lui revient quand même.
  function senderFor(rep, settings) {
    if (!rep?.email) return settings.merchantFrom ? { from: settings.merchantFrom } : {};
    const email = String(rep.email).toLowerCase();
    const name = String(rep.name || email).replace(/["<>\r\n]/g, '').slice(0, 80);
    const verified = String(process.env.HR_SENDER_DOMAINS || 'clustersystems.com').split(',')
      .map((d) => d.trim().toLowerCase()).filter((d) => d && d !== 'none');
    if (settings.sendFromRep !== false && verified.includes(email.split('@')[1] || '')) {
      return { from: `"${name}" <${email}>`, replyTo: email };
    }
    const baseFrom = String(settings.merchantFrom || process.env.SMTP_FROM || process.env.SMTP_USER || '');
    const addr = (/<([^>]+)>/.exec(baseFrom) || [null, baseFrom])[1].trim();
    return addr ? { from: `"${name} (Cluster)" <${addr}>`, replyTo: email } : { replyTo: email };
  }

  // ── Disponibilité ─────────────────────────────────────────────────────────
  async function busyFor(repEmail, timeMin, timeMax, excludeLeadId, minutes = 30) {
    const out = { busy: [], source: 'saleshub', googleError: null };
    if (!repEmail) return out;
    // Les rendez-vous déjà pris dans Sales Hub pour ce représentant, même si l'écriture Google
    // avait échoué pour l'un d'eux.
    try {
      await ensureSchema();
      const r = await pool.query(
        `SELECT callback_at FROM leads
          WHERE status = 'accepted' AND LOWER(assigned_rep_email) = LOWER($1) AND id <> $2
            AND callback_at IS NOT NULL AND callback_at BETWEEN $3 AND $4
            AND COALESCE(booking_status, 'proposed') <> 'cancelled'`,
        [repEmail, excludeLeadId || 0, new Date(timeMin.getTime() - 4 * 3600000).toISOString(), timeMax.toISOString()]);
      for (const row of r.rows) {
        const s = new Date(row.callback_at);
        out.busy.push({ start: s, end: new Date(s.getTime() + minutes * 60000) });
      }
    } catch (e) { console.warn('[rdv] rendez-vous Sales Hub illisibles :', e.message); }
    if (G.configured()) {
      try {
        out.busy.push(...await G.freeBusy(repEmail, timeMin, timeMax));
        out.source = 'google';
      } catch (e) { out.googleError = e.message.slice(0, 300); }
    }
    return out;
  }

  async function slotsFor({ repEmail, leadId, current, settings, now = new Date() }) {
    const days = Number(settings.bookingDays) || 5;
    const w = S.window({ now, days, tz: TZ });
    const minutes = Number(settings.slotMinutes) || 30;
    const b = await busyFor(repEmail, w.timeMin, w.timeMax, leadId, minutes);
    const list = S.computeSlots({
      now, busy: b.busy, days, slotMinutes: minutes, minNoticeHours: settings.minNoticeHours ?? 2,
      businessHours: settings.businessHours, tz: TZ,
      exclude: current ? { start: new Date(current), end: new Date(new Date(current).getTime() + minutes * 60000) } : null,
    });
    return { days: list, source: b.source, googleError: b.googleError };
  }

  // L'heure PROPOSÉE à l'acceptation : le premier créneau libre à partir de l'heure que le délai
  // configuré aurait donnée. Rien de libre dans la fenêtre → l'heure brute, comme avant.
  async function proposeAt(rep, settings, from, leadId) {
    try {
      const r = await slotsFor({ repEmail: rep?.email, leadId, current: null, settings });
      const at = S.firstFreeFrom(r.days, from);
      return { at: at || from, source: r.source, googleError: r.googleError, fallback: !at };
    } catch (e) {
      return { at: from, source: 'none', googleError: e.message, fallback: true };
    }
  }

  // ── Google Agenda ─────────────────────────────────────────────────────────
  function eventBody(lead, at, settings, crmLeadId, withMeet) {
    const minutes = Number(settings.slotMinutes) || 30;
    const who = [lead.contact_first_name, lead.contact_last_name].filter(Boolean).join(' ');
    return {
      summary: `Rendez-vous — ${lead.business_name}${who ? ` (${who})` : ''}`.slice(0, 250),
      description: [
        `Piste ${lead.ref_code} — rendez-vous pris via Sales Hub.`,
        who ? `Contact : ${who}` : null,
        lead.contact_phone ? `Tél. : ${lead.contact_phone}` : null,
        lead.contact_email ? `Courriel : ${lead.contact_email}` : null,
        `Langue : ${lead.language === 'en' ? 'anglais' : 'français'}`,
        crmLeadId ? `Zoho : https://crm.zoho.com/crm/tab/Leads/${crmLeadId}` : null,
        '',
        'Le client peut déplacer ce rendez-vous depuis son courriel : cet événement suivra tout seul.',
      ].filter((l) => l !== null).join('\n'),
      start: { dateTime: new Date(at).toISOString(), timeZone: TZ },
      end: { dateTime: new Date(new Date(at).getTime() + minutes * 60000).toISOString(), timeZone: TZ },
      extendedProperties: { private: { salesHubLeadRef: String(lead.ref_code) } },
      reminders: { useDefault: true },
      // Google Meet, créé par Google au nom du représentant. `requestId` unique par création :
      // Google s'en sert pour ne pas créer deux conférences si la requête est rejouée.
      ...(withMeet ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
    };
  }

  async function upsertEvent(lead, repEmail, at, settings, crmLeadId) {
    if (!G.configured()) return { ok: false, skipped: 'google_not_configured' };
    if (!repEmail) return { ok: false, skipped: 'no_rep_email' };
    try {
      const withMeet = settings.includeMeet !== false;
      if (lead.gcal_event_id && String(lead.gcal_calendar || '').toLowerCase() === repEmail.toLowerCase()) {
        const p = await G.patchEvent(repEmail, lead.gcal_event_id, eventBody(lead, at, settings, crmLeadId, false));
        if (p.ok) return { ok: true, id: lead.gcal_event_id, calendar: repEmail, moved: true, meetUrl: p.meetUrl || lead.gcal_meet_url || null };
        if (!p.gone) return { ok: false, error: p.error };
      }
      const r = await G.insertEvent(repEmail, eventBody(lead, at, settings, crmLeadId, withMeet));
      if (!r.ok) return { ok: false, error: r.error };
      // Événement créé mais Meet absent (Meet désactivé pour ce compte, par exemple) : l'appel
      // reste valable, on le dit dans le journal plutôt que d'échouer.
      return { ok: true, id: r.id, calendar: repEmail, meetUrl: r.meetUrl || null, ...(withMeet && !r.meetUrl ? { meetMissing: true } : {}) };
    } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
  }

  // ── Zoho : déplacer / créer / retirer le rappel ───────────────────────────
  async function zohoMove(lead, at, settings, rep) {
    const pad = (n) => String(n).padStart(2, '0');
    const kind = lead.crm_followup_kind === 'Tasks' ? 'Tasks' : 'Calls';
    if (!lead.crm_followup_id) {
      if (!lead.crm_lead_id) return { ok: false, skipped: 'no_crm_lead' };
      const cb = await h().scheduleLeadCallback(lead, rep, lead.crm_lead_id, new Date(at), settings);
      return cb.ok ? { ok: true, created: true, id: cb.id, kind: cb.kind } : { ok: false, error: cb.error };
    }
    const d = new Date(at);
    const p = h().tzParts(d);
    const dateStr = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    const data = kind === 'Calls'
      ? { Call_Start_Time: `${dateStr}T${pad(p.hour)}:${pad(p.minute)}:00${h().tzOffsetString(d)}` }
      : { Due_Date: dateStr };
    try {
      const token = await ensureValidCrmToken();
      const r = await axios.put(`https://www.zohoapis.com/crm/v2/${kind}/${lead.crm_followup_id}`, { data: [data] },
        { headers: { Authorization: `Zoho-oauthtoken ${token}` }, validateStatus: () => true, timeout: 20000 });
      const res = r.data?.data?.[0];
      if (r.status >= 200 && r.status < 300 && res?.status === 'success') return { ok: true, id: lead.crm_followup_id, kind };
      return { ok: false, error: String(res?.message || r.data?.message || `HTTP ${r.status}`).slice(0, 300) };
    } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
  }
  async function zohoRemove(lead) {
    if (!lead.crm_followup_id) return { ok: true, skipped: 'none' };
    const kind = lead.crm_followup_kind === 'Tasks' ? 'Tasks' : 'Calls';
    try {
      const token = await ensureValidCrmToken();
      const r = await axios.delete(`https://www.zohoapis.com/crm/v2/${kind}/${lead.crm_followup_id}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` }, validateStatus: () => true, timeout: 20000 });
      const res = r.data?.data?.[0];
      if ((r.status >= 200 && r.status < 300 && res?.status === 'success') || r.status === 204) return { ok: true };
      return { ok: false, error: String(res?.message || r.data?.message || `HTTP ${r.status}`).slice(0, 300) };
    } catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
  }

  // ── Aides appelées par acceptLead() ───────────────────────────────────────
  // Émet le lien (l'ancien meurt) et rend l'adresse complète à mettre dans le courriel.
  async function issueLink(leadId) {
    await ensureSchema();
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query(`UPDATE leads SET booking_token_hash = $2 WHERE id = $1`, [leadId, sha(token)]);
    return `${base()}/rdv?token=${token}`;
  }
  async function recordAccepted(leadId, { at, event }) {
    await ensureSchema();
    await pool.query(
      `UPDATE leads SET booking_status = $2, booking_updated_at = CURRENT_TIMESTAMP,
              gcal_event_id = $3, gcal_calendar = $4, gcal_meet_url = $5 WHERE id = $1`,
      [leadId, at ? 'proposed' : null, event?.ok ? event.id : null, event?.ok ? event.calendar : null, event?.ok ? event.meetUrl || null : null]);
  }

  // ── Page publique ─────────────────────────────────────────────────────────
  const clientIp = (req) => {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || req.ip || '';
  };
  async function loadByToken(req, res) {
    if (rateLimited(`rdv:${clientIp(req)}`, 60)) { res.status(429).json({ error: 'too_many_requests' }); return null; }
    const token = String(req.params.token || '');
    if (token.length < 20) { res.status(404).json({ error: 'not_found' }); return null; }
    await ensureSchema();
    const lead = (await pool.query(`SELECT * FROM leads WHERE booking_token_hash = $1`, [sha(token)])).rows[0];
    if (!lead) { res.status(404).json({ error: 'not_found' }); return null; }
    if (lead.status !== 'accepted') { res.status(410).json({ error: 'closed' }); return null; }
    const since = lead.reviewed_at ? new Date(lead.reviewed_at).getTime() : Date.now();
    if (Date.now() - since > BOOKING_LINK_DAYS * 86400000) { res.status(410).json({ error: 'expired' }); return null; }
    return { lead, token };
  }
  const current = (lead) => (lead.callback_at && lead.booking_status !== 'cancelled' ? new Date(lead.callback_at) : null);
  const repOf = (lead) => ({ name: lead.assigned_rep_name, email: lead.assigned_rep_email, crmUserId: lead.assigned_crm_user_id });

  app.get('/api/public/lead-booking/:token', async (req, res) => {
    try {
      const got = await loadByToken(req, res);
      if (!got) return;
      const { lead } = got;
      const settings = await h().leadSettings();
      const cur = current(lead);
      const past = !!cur && cur.getTime() < Date.now();
      const r = past || settings.bookingEnabled === false
        ? { days: [], source: null }
        : await slotsFor({ repEmail: lead.assigned_rep_email, leadId: lead.id, current: cur, settings });
      res.json({
        lang: lead.language === 'en' ? 'en' : 'fr',
        businessName: lead.business_name,
        firstName: lead.contact_first_name || null,
        repName: lead.assigned_rep_name || null,
        appointment: cur ? { at: cur.toISOString(), status: lead.booking_status || 'proposed', meetUrl: lead.gcal_meet_url || null } : null,
        cancelled: lead.booking_status === 'cancelled',
        past,
        enabled: settings.bookingEnabled !== false,
        allowCancel: settings.allowCancel !== false,
        slotMinutes: Number(settings.slotMinutes) || 30,
        days: r.days,
      });
    } catch (e) {
      console.error('[rdv] lecture :', e.message);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // Réserver, confirmer l'heure proposée (même instant), ou déplacer.
  app.post('/api/public/lead-booking/:token/book', async (req, res) => {
    let client = null, lockKey = null;
    try {
      const got = await loadByToken(req, res);
      if (!got) return;
      let { lead } = got;
      const settings = await h().leadSettings();
      if (settings.bookingEnabled === false) return res.status(410).json({ error: 'disabled' });
      const at = new Date(req.body?.at);
      if (!Number.isFinite(at.getTime())) return res.status(400).json({ error: 'invalid_time' });
      const prev = current(lead);
      if (prev && prev.getTime() < Date.now()) return res.status(409).json({ error: 'past' });

      // Verrou par représentant : vérifier et réserver ne font qu'un.
      lockKey = String(lead.assigned_rep_email || `lead:${lead.id}`).toLowerCase();
      client = await pool.connect();
      await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [`rdv:${lockKey}`]);
      lead = (await client.query(`SELECT * FROM leads WHERE id = $1`, [lead.id])).rows[0];
      const cur = current(lead);
      const same = cur && cur.getTime() === at.getTime();

      if (!same) {
        const r = await slotsFor({ repEmail: lead.assigned_rep_email, leadId: lead.id, current: cur, settings });
        const ok = r.days.some((d) => d.slots.includes(at.toISOString()));
        if (!ok) return res.status(409).json({ error: 'slot_taken' });
      }

      const rep = repOf(lead);
      const steps = {};
      if (!same) {
        steps.crm = await zohoMove(lead, at, settings, rep);
        steps.calendar = await upsertEvent(lead, rep.email, at, settings, lead.crm_lead_id);
      } else if (!lead.gcal_event_id) {
        steps.calendar = await upsertEvent(lead, rep.email, at, settings, lead.crm_lead_id);
      }
      await client.query(
        `UPDATE leads SET callback_at = $2, booking_status = 'confirmed', booking_updated_at = CURRENT_TIMESTAMP,
                booking_changes = booking_changes + $3,
                crm_followup_id   = COALESCE($4, crm_followup_id),
                crm_followup_kind = COALESCE($5, crm_followup_kind),
                gcal_event_id     = COALESCE($6, gcal_event_id),
                gcal_calendar     = COALESCE($7, gcal_calendar),
                gcal_meet_url     = COALESCE($8, gcal_meet_url)
          WHERE id = $1`,
        [lead.id, at.toISOString(), same ? 0 : 1,
         steps.crm?.created ? steps.crm.id : null, steps.crm?.created ? steps.crm.kind : null,
         steps.calendar?.ok ? steps.calendar.id : null, steps.calendar?.ok ? steps.calendar.calendar : null,
         steps.calendar?.ok ? steps.calendar.meetUrl || null : null]);

      const meetUrl = (steps.calendar?.ok && steps.calendar.meetUrl) || lead.gcal_meet_url || null;
      const fresh = { ...lead, callback_at: at, booking_status: 'confirmed', gcal_meet_url: meetUrl };
      const lang = lead.language === 'en' ? 'en' : 'fr';
      const bookingUrl = `${base()}/rdv?token=${got.token}`;
      const mail = E.clientConfirmEmail(mailChrome, {
        lang, firstName: lead.contact_first_name, businessName: lead.business_name,
        repName: rep.name, repEmail: rep.email, at, bookingUrl, meetUrl, kind: 'booked', home: settings.merchantSiteUrl,
      });
      const cal = E.ics({
        location: meetUrl,
        uid: `lead-${lead.ref_code}@saleshub.clusterpos.com`, at, minutes: Number(settings.slotMinutes) || 30,
        title: lang === 'en' ? `Meeting with ${rep.name || 'Cluster'} — Cluster` : `Rendez-vous avec ${rep.name || 'Cluster'} — Cluster`,
        description: [
          meetUrl ? (lang === 'en' ? `Google Meet: ${meetUrl}` : `Google Meet : ${meetUrl}`) : null,
          lang === 'en' ? `To change: ${bookingUrl}` : `Pour changer : ${bookingUrl}`,
        ].filter(Boolean).join('\n'),
        organizerName: rep.name, organizerEmail: rep.email, sequence: (lead.booking_changes || 0) + 1,
      });
      steps.clientEmail = lead.contact_email
        ? await sendMail(lead.contact_email, mail.subject, mail.html, {
            ...senderFor(rep, settings),
            attachments: [{ filename: lang === 'en' ? 'call.ics' : 'rendez-vous.ics', content: Buffer.from(cal), contentType: 'text/calendar; charset=utf-8' }],
          })
        : { sent: false, reason: 'no_contact_email' };
      if (rep.email && (!same || lead.booking_status !== 'confirmed')) {
        const m = E.repChangedEmail(mailShell, { lead: fresh, at, previousAt: same ? null : cur, kind: 'booked', crmLeadId: lead.crm_lead_id, base: base(), meetUrl });
        steps.repEmail = await sendMail(rep.email, m.subject, m.html);
      }

      const label = E.whenLabel(at, 'fr');
      logActivity('lead', lead.id, same ? 'booking_confirmed' : (cur ? 'booking_moved' : 'booking_booked'),
        `${lead.ref_code} — ${same ? `le client a confirmé l'appel du ${label}` : cur ? `le client a déplacé l'appel au ${label} (avant : ${E.whenLabel(cur, 'fr')})` : `le client a choisi l'appel du ${label}`}`
        + (steps.crm && !steps.crm.ok && !steps.crm.skipped ? ` · Zoho : ${steps.crm.error}` : '')
        + (steps.calendar && !steps.calendar.ok && !steps.calendar.skipped ? ` · Google : ${steps.calendar.error}` : ''),
        lead.contact_email || 'client', { metadata: { at: at.toISOString(), previous: cur ? cur.toISOString() : null, steps } });

      res.json({ ok: true, appointment: { at: at.toISOString(), status: 'confirmed', meetUrl }, emailSent: !!steps.clientEmail?.sent });
    } catch (e) {
      console.error('[rdv] réservation :', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'server_error' });
    } finally {
      if (client) {
        try { await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`rdv:${lockKey}`]); } catch { /* la connexion rendue libère le verrou */ }
        client.release();
      }
    }
  });

  app.post('/api/public/lead-booking/:token/cancel', async (req, res) => {
    try {
      const got = await loadByToken(req, res);
      if (!got) return;
      const { lead } = got;
      const settings = await h().leadSettings();
      if (settings.allowCancel === false) return res.status(403).json({ error: 'cancel_not_allowed' });
      const cur = current(lead);
      if (!cur) return res.json({ ok: true, alreadyCancelled: true });
      if (cur.getTime() < Date.now()) return res.status(409).json({ error: 'past' });

      const rep = repOf(lead);
      const steps = {};
      steps.crm = await zohoRemove(lead);
      steps.calendar = lead.gcal_event_id && G.configured()
        ? await G.deleteEvent(lead.gcal_calendar || rep.email, lead.gcal_event_id).catch((e) => ({ ok: false, error: e.message }))
        : { ok: true, skipped: 'none' };
      await pool.query(
        `UPDATE leads SET callback_at = NULL, booking_status = 'cancelled', booking_updated_at = CURRENT_TIMESTAMP,
                booking_changes = booking_changes + 1,
                crm_followup_id   = CASE WHEN $2 THEN NULL ELSE crm_followup_id END,
                gcal_event_id     = CASE WHEN $3 THEN NULL ELSE gcal_event_id END,
                gcal_meet_url     = CASE WHEN $3 THEN NULL ELSE gcal_meet_url END
          WHERE id = $1`,
        [lead.id, !!steps.crm.ok, !!steps.calendar.ok]);

      const lang = lead.language === 'en' ? 'en' : 'fr';
      const bookingUrl = `${base()}/rdv?token=${got.token}`;
      const mail = E.clientConfirmEmail(mailChrome, {
        lang, firstName: lead.contact_first_name, businessName: lead.business_name,
        repName: rep.name, repEmail: rep.email, at: null, bookingUrl, kind: 'cancelled', home: settings.merchantSiteUrl,
      });
      if (lead.contact_email) steps.clientEmail = await sendMail(lead.contact_email, mail.subject, mail.html, senderFor(rep, settings));
      if (rep.email) {
        const m = E.repChangedEmail(mailShell, { lead, at: null, previousAt: cur, kind: 'cancelled', crmLeadId: lead.crm_lead_id, base: base() });
        steps.repEmail = await sendMail(rep.email, m.subject, m.html);
      }
      logActivity('lead', lead.id, 'booking_cancelled',
        `${lead.ref_code} — le client a annulé l'appel du ${E.whenLabel(cur, 'fr')}`
        + (!steps.crm.ok ? ` · Zoho : ${steps.crm.error}` : '') + (!steps.calendar.ok ? ` · Google : ${steps.calendar.error}` : ''),
        lead.contact_email || 'client', { metadata: { previous: cur.toISOString(), steps } });
      res.json({ ok: true });
    } catch (e) {
      console.error('[rdv] annulation :', e.message);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ── Admin : état de la connexion Google + essai sur un représentant ───────
  app.get('/api/admin/lead-booking/status', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:manage_rules'))) return;
    res.json({ google: { configured: G.configured(), serviceAccount: G.serviceAccountInfo() } });
  });
  app.post('/api/admin/lead-booking/test', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, 'leads:manage_rules'))) return;
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });
    if (!G.configured()) return res.json({ ok: false, error: 'google_not_configured' });
    try {
      const settings = await h().leadSettings();
      const w = S.window({ days: Number(settings.bookingDays) || 5, tz: TZ });
      const busy = await G.freeBusy(email, w.timeMin, w.timeMax);
      const list = S.computeSlots({ busy, days: Number(settings.bookingDays) || 5, slotMinutes: settings.slotMinutes,
        minNoticeHours: settings.minNoticeHours, businessHours: settings.businessHours, tz: TZ });
      res.json({ ok: true, busyBlocks: busy.length, freeSlots: list.reduce((n, d) => n + d.slots.length, 0), firstFree: S.firstFreeFrom(list, new Date()) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Suppression d'une piste (DELETE /api/leads/:id) : l'evenement du representant part avec elle.
  const deleteEvent = async (email, eventId) => {
    if (!G.configured() || !email || !eventId) return { ok: true, skipped: true };
    return G.deleteEvent(email, eventId).catch((e) => ({ ok: false, error: e.message }));
  };

  return { senderFor, proposeAt, upsertEvent, issueLink, recordAccepted, deleteEvent, welcomeBookingBlock: E.welcomeBookingBlock, emails: E, googleConfigured: G.configured };
}

module.exports = { registerLeadBookingRoutes };
