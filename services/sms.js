// ============================================================================
// SMS sortants — Twilio, par son API REST (aucune dépendance ajoutée).
//
// Demandé par David le 2026-10-01 : les représentants veulent un texto quand une nouvelle piste
// leur est attribuée. INERTE tant que Railway n'a pas les variables : sans elles, sendSms()
// rend { sent: false, reason: 'not_configured' } et rien d'autre ne change — le courriel au
// représentant part comme avant.
//
//   TWILIO_ACCOUNT_SID           obligatoire (AC…)
//   TWILIO_AUTH_TOKEN            obligatoire
//   TWILIO_FROM                  le numéro Twilio expéditeur, format +15145551234
//   TWILIO_MESSAGING_SERVICE_SID facultatif (MG…) : remplace TWILIO_FROM s'il est fourni
//
// Les variables sont lues À CHAQUE envoi, pas au chargement : les ajouter dans Railway suffit au
// prochain redémarrage, sans toucher au code.
// ============================================================================
const axios = require('axios');

function smsConfig() {
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  const from = (process.env.TWILIO_FROM || '').trim();
  const service = (process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim();
  return { sid, token, from, service, ok: !!(sid && token && (from || service)) };
}

const smsConfigured = () => smsConfig().ok;

// Numéro nord-américain → E.164. Rend null pour tout ce qui ne se lit pas sans deviner : un
// texto envoyé au mauvais numéro est pire qu'un texto non envoyé.
function toE164(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

async function sendSms(to, body) {
  const cfg = smsConfig();
  if (!cfg.ok) return { sent: false, reason: 'not_configured' };
  const dest = toE164(to);
  if (!dest) return { sent: false, reason: 'bad_number' };
  const form = new URLSearchParams({ To: dest, Body: String(body || '').slice(0, 640) });
  if (cfg.service) form.set('MessagingServiceSid', cfg.service); else form.set('From', cfg.from);
  try {
    const r = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Messages.json`,
      form.toString(),
      {
        auth: { username: cfg.sid, password: cfg.token },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true, timeout: 15000,
      });
    if (r.status >= 200 && r.status < 300) return { sent: true, sid: r.data?.sid || null, to: dest };
    // 21610 = le destinataire a répondu STOP : Twilio refuse, et c'est voulu.
    return { sent: false, reason: `twilio_${r.status}${r.data?.code ? `_${r.data.code}` : ''}`, detail: String(r.data?.message || '').slice(0, 200) };
  } catch (e) {
    return { sent: false, reason: 'network', detail: e.message };
  }
}

module.exports = { sendSms, smsConfigured, toE164 };
