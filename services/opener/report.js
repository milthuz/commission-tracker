// ============================================================================
// Rapport quotidien des openers (2026-10-09, demande de David : « un endroit où on peut planifier
// et recevoir un rapport des visites de Hao après sa journée, choisir à qui l'envoyer »).
//
// UN courriel par jour ouvrable, à l'heure choisie (heure de Montréal), avec une section par
// opener qui a eu une route ou des check-ins ce jour-là : chaque visite (arrivée, départ, durée,
// vérification GPS, POS, intérêt, satisfaction d'un client, lead, notes), les arrêts non visités
// avec leur raison, et les totaux. Réglages dans app_settings `opener_daily_report` :
//   { enabled, hour, recipients: [courriels], openers: [courriels] (vide = tous) }
// Envoi par le worker (runDue, toutes les 10 min) : une fois par jour, jamais un jour férié ni une
// fin de semaine. « Aperçu » et « Envoyer maintenant » pour n'importe quelle date.
// Permission : opener:reports.
// ============================================================================

const { verdict, ymdMtl } = require('./field');
const { isHoliday } = require('./holidays');

const PERM = 'opener:reports';
const KEY = 'opener_daily_report';
const SENT_KEY = 'opener_daily_report_sent';
const TZ = 'America/Toronto';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULTS = { enabled: false, hour: 18, recipients: [], openers: [] };

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hhmm = (d) => (d ? new Date(d).toLocaleTimeString('fr-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDayFr = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('fr-CA', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const fmtDayEn = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
const isWorkday = (ymd) => { const w = new Date(`${ymd}T12:00:00Z`).getUTCDay(); return w !== 0 && w !== 6 && !isHoliday(ymd); };
const mtlHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(d));

const VERDICT = { onsite: ['Sur place', '#047857'], far: ['À distance', '#B91C1C'], imprecise: ['Position imprécise', '#B45309'], nogps: ['Sans position', '#64748B'] };
const SKIP = { closed: 'fermé à l\'arrivée', no_time: 'manque de temps', refused: 'refus d\'entrer', other: 'autre raison',
  postponed: 'reporté', excluded: 'pas un restaurant (exclu)' };
const PAY = { cluster: 'Cluster', other: 'un autre', unknown: 'inconnu' };

// Le courriel, à partir des sections déjà calculées. Exporté pour l'aperçu des gabarits.
// sections = [{ name, email, route: { name } | null, visits: [...], notVisited: [...], leads: [...], totals }]
function dailyReportEmail(mailShell, date, sections, link) {
  const totalVisits = sections.reduce((a, s) => a + s.totals.visits, 0);
  const totalLeads = sections.reduce((a, s) => a + s.totals.leads, 0);
  const subject = `📋 Rapport des openers — ${fmtDayFr(date)} : ${totalVisits} visite${totalVisits > 1 ? 's' : ''}, ${totalLeads} lead${totalLeads > 1 ? 's' : ''} / Openers report`;
  const cell = 'padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:12.5px;vertical-align:top';
  const body = sections.map((s) => {
    const T = s.totals;
    const head = `<h2 style="margin:18px 0 4px;font-size:16px;color:#0f1722">${esc(s.name)}</h2>`
      + `<p style="margin:0 0 8px;color:#64748b;font-size:13px">${s.route ? `Route ${esc(s.route.name)} · ` : 'Aucune route · '}`
      + `${T.done}/${T.stops} arrêts visités · ${T.visits} check-in${T.visits > 1 ? 's' : ''} · ${T.leads} lead${T.leads > 1 ? 's' : ''}`
      + ` · ${T.onsite} sur place${T.far ? `, <b style="color:#B91C1C">${T.far} à distance</b>` : ''}`
      + `${T.firstAt ? ` · de ${hhmm(T.firstAt)} à ${hhmm(T.lastAt)}` : ''}${T.visitMinutes ? ` · ${T.visitMinutes} min en visite` : ''}</p>`;
    const rows = s.visits.map((v) => {
      const [vl, vc] = VERDICT[v.verdict] || VERDICT.nogps;
      const details = [
        v.currentPos ? `POS : ${esc(v.currentPos)}` : null,
        v.interest ? `intérêt ${v.interest}/5` : null,
        v.satisfaction ? `<b>satisfaction ${v.satisfaction}/5</b>${v.paymentsBy ? ` · paiements : ${esc(PAY[v.paymentsBy] || v.paymentsBy)}` : ''}` : null,
        v.decisionMaker === 'yes' ? 'décideur rencontré' : null,
        v.leadRef ? `<b>lead ${esc(v.leadRef)}</b>` : null,
      ].filter(Boolean).join(' · ');
      return `<tr><td style="${cell};white-space:nowrap">${hhmm(v.startedAt || v.at)}–${hhmm(v.at)}${v.durationMin != null ? `<br><span style="color:#64748b">${v.durationMin} min</span>` : ''}</td>`
        + `<td style="${cell}"><b>${esc(v.name || '—')}</b>${v.isClient ? ' <span style="color:#047857">(client)</span>' : ''}<br><span style="color:#475569">${details}</span>`
        + `${v.notes ? `<br><span style="color:#64748b;font-style:italic">« ${esc(String(v.notes).slice(0, 300))} »</span>` : ''}</td>`
        + `<td style="${cell};white-space:nowrap;color:${vc}">${vl}${v.distanceM != null && v.verdict === 'far' ? `<br>${Math.round(v.distanceM)} m` : ''}</td></tr>`;
    }).join('');
    const table = rows
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 8px">`
        + `<tr><th style="${cell};text-align:left;color:#64748b">Heure</th><th style="${cell};text-align:left;color:#64748b">Restaurant</th><th style="${cell};text-align:left;color:#64748b">Vérification</th></tr>${rows}</table>`
      : '<p style="margin:0 0 8px;color:#64748b;font-size:13px">Aucune visite enregistrée.</p>';
    const nv = s.notVisited.length
      ? `<p style="margin:4px 0 2px;font-size:13px;color:#0f1722"><b>Non visités (${s.notVisited.length})</b></p><p style="margin:0 0 8px;font-size:12.5px;color:#475569">`
        + s.notVisited.map((x) => `${esc(x.name)}${x.skipReason ? ` — ${esc(SKIP[x.skipReason] || x.skipReason)}` : ' — pas encore visité'}`).join('<br>') + '</p>'
      : '';
    return head + table + nv;
  }).join('<hr style="border:none;border-top:1px solid #e2e8f0;margin:14px 0">');
  const intro = `<p style="margin:0 0 6px">Rapport du <b>${esc(fmtDayFr(date))}</b>.</p>`
    + `<p style="margin:0 0 6px;color:#64748b">Openers report for ${esc(fmtDayEn(date))}.</p>`
    + (sections.length ? body : '<p style="color:#64748b">Aucun opener n\'avait de route ni de visite ce jour-là.</p>');
  return { subject, html: mailShell('Rapport des openers · Openers report', intro, 'Voir le suivi / Open tracking', link) };
}

function registerOpenerReport(app, deps) {
  const { authenticateToken, requirePerm, pool, logActivity, field } = deps;
  const late = () => (deps.late ? deps.late() : {});
  const now = deps.now || (() => new Date());
  const actorOf = (req) => req.user?.realAdminEmail || req.user?.email || 'unknown';

  async function getSettings() {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [KEY]).catch(() => ({ rows: [] }));
    const v = r.rows[0]?.value;
    const s = v && typeof v === 'object' ? v : (typeof v === 'string' ? JSON.parse(v) : {});
    return { ...DEFAULTS, ...s };
  }
  const cleanEmails = (list) => [...new Set((Array.isArray(list) ? list : []).map((e) => String(e).trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))].slice(0, 50);

  // Les openers à rapporter pour une date : route publiée/fermée ce jour-là OU check-ins.
  async function openersFor(date, only) {
    const { rows } = await pool.query(
      `SELECT DISTINCT LOWER(e) AS email FROM (
         SELECT opener_email AS e FROM opener_routes WHERE route_date = $1::date AND status IN ('published','closed') AND opener_email IS NOT NULL
         UNION SELECT user_email FROM opener_checkins WHERE (at AT TIME ZONE '${TZ}')::date = $1::date) x ORDER BY 1`, [date]);
    const keep = new Set(cleanEmails(only));
    return rows.map((r) => r.email).filter((e) => !keep.size || keep.has(e));
  }

  async function section(email, date) {
    const route = (await pool.query(
      `SELECT id, name, status FROM opener_routes WHERE LOWER(opener_email) = $1 AND route_date = $2::date AND status IN ('published','closed') ORDER BY id LIMIT 1`,
      [email, date])).rows[0] || null;
    const stops = route ? (await pool.query(
      `SELECT id, position, label, outcome, skip_reason, place_id FROM opener_route_stops WHERE route_id = $1 ORDER BY position`, [route.id])).rows : [];
    const byStop = new Map(stops.map((s) => [s.id, s]));
    const cks = (await pool.query(
      `SELECT c.*, COALESCE(c.start_lat, c.lat) AS v_lat,
              CASE WHEN c.start_lat IS NOT NULL THEN c.start_distance_m ELSE c.distance_m END AS v_dist,
              CASE WHEN c.start_lat IS NOT NULL THEN c.start_accuracy_m ELSE c.accuracy_m END AS v_acc,
              ROUND(EXTRACT(EPOCH FROM (c.at - c.started_at)) / 60)::int AS duration_min,
              ld.ref_code, ld.business_name AS lead_name,
              EXISTS (SELECT 1 FROM cluster_locations l WHERE l.place_id = c.place_id AND l.active AND l.missing_since IS NULL) AS is_client
         FROM opener_checkins c LEFT JOIN leads ld ON ld.id = c.lead_id
        WHERE LOWER(c.user_email) = $1 AND (c.at AT TIME ZONE '${TZ}')::date = $2::date ORDER BY c.at`, [email, date])).rows;
    const visits = cks.map((c) => ({
      at: c.at, startedAt: c.started_at, durationMin: c.duration_min > 0 ? c.duration_min : null,
      name: byStop.get(c.route_stop_id)?.label || c.lead_name || null,
      verdict: verdict(c.v_dist, c.v_acc, c.v_lat), distanceM: c.v_dist,
      currentPos: c.current_pos, interest: c.interest_level, satisfaction: c.satisfaction, paymentsBy: c.payments_by,
      decisionMaker: c.decision_maker, notes: c.notes, leadRef: c.ref_code || null, isClient: c.is_client,
    }));
    const leads = (await pool.query(
      `SELECT ref_code, business_name, status FROM leads WHERE raw->>'via' = 'opener' AND LOWER(created_by) = $1
          AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date = $2::date ORDER BY id`, [email, date]).catch(() => ({ rows: [] }))).rows;
    const notVisited = stops.filter((s) => s.outcome !== 'done').map((s) => ({ name: s.label, skipReason: s.skip_reason }));
    return {
      email, name: (await field.displayName(email)) || email, route: route ? { id: route.id, name: route.name } : null,
      visits, notVisited, leads,
      totals: {
        stops: stops.length, done: stops.filter((s) => s.outcome === 'done').length, visits: visits.length, leads: leads.length,
        onsite: visits.filter((v) => v.verdict === 'onsite').length, far: visits.filter((v) => v.verdict === 'far').length,
        firstAt: cks[0]?.started_at || cks[0]?.at || null, lastAt: cks.length ? cks[cks.length - 1].at : null,
        visitMinutes: visits.reduce((a, v) => a + (v.durationMin || 0), 0),
      },
    };
  }

  async function build(date, only) {
    const emails = await openersFor(date, only);
    const sections = [];
    for (const e of emails) sections.push(await section(e, date));
    const L = late();
    const link = `${field.frontend ? field.frontend() : ''}/opener-routes`;
    const mail = dailyReportEmail(L.mailShell || ((t, b) => `<h1>${t}</h1>${b}`), date, sections, link);
    return { date, sections, ...mail };
  }

  async function send(date, { openers, recipients, reason, actor }) {
    const to = cleanEmails(recipients);
    if (!to.length) { const e = new Error('no_recipients'); e.code = 400; throw e; }
    const r = await build(date, openers);
    const L = late();
    if (!L.sendMail) throw new Error('courriel indisponible');
    await L.sendMail(to.join(','), r.subject, r.html);
    Promise.resolve(logActivity && logActivity('opener_report', date, 'sent',
      `Rapport des openers du ${date} (${reason}) → ${to.length} destinataire(s), ${r.sections.length} opener(s)`, actor || 'system')).catch(() => {});
    return { sent: to.length, openers: r.sections.length };
  }

  // Worker : toutes les 10 min. Une fois par jour ouvrable, à partir de l'heure choisie.
  async function runDue() {
    try {
      const s = await getSettings();
      if (!s.enabled) return { skipped: 'disabled' };
      const today = ymdMtl(now());
      if (!isWorkday(today)) return { skipped: 'not_workday' };
      if (mtlHour(now()) < Number(s.hour)) return { skipped: 'too_early' };
      const done = (await pool.query(`SELECT value FROM sync_state WHERE key = $1`, [SENT_KEY])).rows[0]?.value;
      if (done === today) return { skipped: 'already_sent' };
      // Marqué AVANT l'envoi : un worker qui redémarre au milieu n'envoie pas deux fois.
      await pool.query(`INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
                        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`, [SENT_KEY, today]);
      if (!cleanEmails(s.recipients).length) return { skipped: 'no_recipients' };
      const emails = await openersFor(today, s.openers);
      if (!emails.length) return { skipped: 'no_activity' };
      const out = await send(today, { openers: s.openers, recipients: s.recipients, reason: 'automatique' });
      console.log('[OPENER] rapport quotidien envoyé :', JSON.stringify(out));
      return out;
    } catch (e) { console.error('[OPENER] rapport quotidien :', e.message); return { error: e.message }; }
  }

  const guard = (req, res) => requirePerm(req, res, PERM);

  app.get('/api/opener/report/settings', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    try {
      const s = await getSettings();
      // Pour les sélecteurs : les openers (rôle avec opener:field) et les usagers connus.
      const openers = (await pool.query(
        `SELECT DISTINCT LOWER(ur.user_email) AS email FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE r.permissions ? 'opener:field' OR r.permissions ? 'opener:*'`)).rows;
      const users = (await pool.query(
        `SELECT LOWER(email) AS email, MAX(display_name) AS name FROM (
           SELECT email, display_name FROM user_tokens UNION ALL SELECT email, display_name FROM local_users) x
          WHERE email IS NOT NULL GROUP BY 1 ORDER BY 2 NULLS LAST, 1`).catch(() => ({ rows: [] }))).rows;
      const named = [];
      for (const o of openers) named.push({ email: o.email, name: (await field.displayName(o.email)) || o.email });
      const last = (await pool.query(`SELECT value, updated_at FROM sync_state WHERE key = $1`, [SENT_KEY])).rows[0] || null;
      res.json({ settings: s, openers: named, users: users.map((u) => ({ email: u.email, displayName: u.name })), lastSent: last?.value || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/opener/report/settings', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    const b = req.body || {};
    const hour = Math.max(12, Math.min(22, parseInt(b.hour, 10) || DEFAULTS.hour));
    const settings = { enabled: b.enabled === true, hour, recipients: cleanEmails(b.recipients), openers: cleanEmails(b.openers) };
    try {
      await pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`, [KEY, JSON.stringify(settings)]);
      Promise.resolve(logActivity && logActivity('opener_report', 'settings', 'updated',
        `Rapport des openers : ${settings.enabled ? `activé à ${hour} h` : 'désactivé'}, ${settings.recipients.length} destinataire(s)`, actorOf(req))).catch(() => {});
      res.json({ settings });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/opener/report/preview', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    const date = DATE_RE.test(String(req.query.date || '')) ? String(req.query.date) : ymdMtl(now());
    const opener = String(req.query.opener || '').trim().toLowerCase();
    try {
      const s = await getSettings();
      const r = await build(date, opener ? [opener] : s.openers);
      res.json({ date, subject: r.subject, html: r.html, openers: r.sections.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/opener/report/send', authenticateToken, async (req, res) => {
    if (!(await guard(req, res))) return;
    const date = DATE_RE.test(String(req.body?.date || '')) ? String(req.body.date) : ymdMtl(now());
    const opener = String(req.body?.opener || '').trim().toLowerCase();
    try {
      const s = await getSettings();
      const out = await send(date, { openers: opener ? [opener] : s.openers, recipients: s.recipients, reason: 'envoi manuel', actor: actorOf(req) });
      res.json(out);
    } catch (e) { res.status(e.code === 400 ? 400 : 500).json({ error: e.message }); }
  });

  return { runDue, build, getSettings };
}

module.exports = { registerOpenerReport, dailyReportEmail, PERM };
