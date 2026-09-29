// Parcours complet du crédit de compensation marchand, de bout en bout, contre une vraie base
// Postgres en mémoire (PGlite) et un vrai serveur HTTP. Zoho Books et le courriel sont simulés.
//   npm install --no-save @electric-sql/pglite   (une fois)
//   node services/credits/__tests__/routes.test.js
//
// ⚠️ Échoue si PGlite est absent plutôt que de se déclarer vert (voir feedback-verify-the-harness).
const assert = require('assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant (npm install --no-save @electric-sql/pglite)'); process.exit(1); }
const { registerCreditRoutes } = require('../routes');

// Signature PNG valide (> 1,5 Ko) fabriquée à la volée.
function fakeSignaturePng() {
  const zlib = require('zlib');
  const w = 300, h = 80;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) {
      const on = Math.abs(y - (40 + 25 * Math.sin(x / 11))) < 2 || (x * 7 + y * 13) % 97 === 0;
      row.writeUInt32BE(on ? 0x141e50ff : ((x * 31 + y * 17) % 256) << 24 >>> 0 & 0x00000000, 1 + x * 4);
      if (!on) row[1 + x * 4 + 3] = (x * y) % 3; // un peu de bruit : le PNG dépasse 1,5 Ko
    }
    rows.push(row);
  }
  const raw = zlib.deflateSync(Buffer.concat(rows), { level: 1 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(require('zlib').crc32 ? require('zlib').crc32(body) : crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', raw), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }

(async () => {
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p) };
  await db.exec(`
    CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, amount NUMERIC, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT, permissions JSONB);
    CREATE TABLE user_roles (user_email TEXT, role_id INT);
    CREATE TABLE user_tokens (email TEXT, is_admin BOOLEAN);
    INSERT INTO roles (name, permissions) VALUES ('Rep', '["credits:send"]'), ('Finance', '["credits:approve"]');
    INSERT INTO user_roles VALUES ('rep@x.com', 1), ('autre@x.com', 1), ('david@x.com', 2);
    CREATE TABLE zentact_merchants (merchant_account_id TEXT PRIMARY KEY, business_name TEXT, invitee_email TEXT, status TEXT, sales_rep_name TEXT);
    INSERT INTO zentact_merchants VALUES
      ('ZM-1', 'Restaurants l''Étoile inc.', 'owner@resto.ca', 'ACTIVE', 'Julie'),
      ('ZM-2', 'Bistro 50% off', 'b@b.ca', 'INVITE_ACCEPTED', 'Julie'),
      ('ZM-3', 'Resto Fermé', 'x@x.ca', 'CLOSED', 'Julie');
  `);
  const perms = { 'rep@x.com': ['credits:send'], 'autre@x.com': ['credits:send'], 'david@x.com': ['credits:approve'], 'nobody@x.com': [] };
  const has = (req, p) => (perms[req.user.email] || []).includes(p);

  const mails = [];
  let booksMode = 'scope_missing';
  const creditNotes = [];
  const fakeBooks = {
    searchCustomers: async (q) => [{ id: '4600001', name: `Resto ${q}`, company: `Resto ${q} inc.`, email: 'owner@resto.ca', phone: '514 555-0100' }],
    getCustomer: async (id) => ({ id, legalName: 'Resto Test inc.', contactPerson: 'Marie Test', email: 'owner@resto.ca', phone: '514 555-0100' }),
    createCreditNote: async (a) => {
      if (booksMode === 'scope_missing') return { ok: false, status: 401, code: 57, message: 'You are not authorized to perform this operation', scopeMissing: true };
      creditNotes.push(a); return { ok: true, id: '9001', number: 'CN-00042' };
    },
  };

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const authenticateToken = (req, res, next) => {
    const e = req.headers['x-test-user']; if (!e) return res.status(401).json({ error: 'auth' });
    req.user = { email: e, name: e.split('@')[0], isAdmin: false }; next();
  };
  const credits = registerCreditRoutes(app, {
    authenticateToken, pool, books: fakeBooks, getAdminBooksAuth: null,
    hasPerm: async (req, p) => has(req, p),
    requirePerm: async (req, res, p) => { if (has(req, p)) return true; res.status(403).json({ error: 'perm' }); return false; },
    logActivity: async (t, id, ev, d, actor, extra = {}) => { await pool.query('INSERT INTO activity_log (entity_type, entity_id, event_type, description, actor, amount) VALUES ($1,$2,$3,$4,$5,$6)', [t, String(id), ev, d, actor, extra.amount == null ? null : extra.amount]); },
    sendMail: async (to, subject, html, opts = {}) => { mails.push({ to, subject, html, opts }); return { sent: true }; },
    mailShell: (title, intro, cta, url) => `<h1>${title}</h1>${intro}${url ? `<a href="${url}">${cta}</a>` : ''}`,
    rateLimited: () => false,
  });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, user, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), ct };
  };
  let n = 0; const ok = (c, m) => { assert(c, m); n++; };

  // Permissions
  ok((await api('GET', '/api/credits/meta', 'nobody@x.com')).status === 403, 'sans permission : 403');
  const meta = (await api('GET', '/api/credits/meta', 'rep@x.com')).body;
  ok(meta.canSend && !meta.canApprove, 'rep : peut envoyer, pas approuver');

  // Recherche Zoho + création
  const zm = (await api('GET', '/api/credits/merchants?q=Rest', 'rep@x.com')).body.merchants;
  ok(zm.length === 1 && zm[0].id === 'ZM-1', 'recherche Zentact : le marchand fermé est exclu');
  ok((await api('GET', '/api/credits/merchants?q=50%25', 'rep@x.com')).body.merchants.map((m) => m.id).join() === 'ZM-2', 'un « % » tapé est cherché tel quel, pas comme joker');
  ok((await api('GET', '/api/credits/merchants?q=%25%25', 'rep@x.com')).body.merchants.length === 0, '« %% » ne renvoie pas toute la liste');
  ok((await api('POST', '/api/credits', 'rep@x.com', { legalName: 'X' })).status === 400, 'marchand Zentact obligatoire');
  ok((await api('POST', '/api/credits', 'rep@x.com', { merchantId: 'ZM-INEXISTANT', legalName: 'X' })).body.error === 'merchant_required', 'marchand Zentact inconnu refusé');
  let c = (await api('POST', '/api/credits', 'rep@x.com', { merchantId: 'ZM-1', legalName: 'Restaurants l’Étoile inc.', contactPerson: 'Marie-Ève', phone: '514', email: 'owner@resto.ca', amount: '2 450,50', lang: 'fr' })).body.credit;
  ok(c.merchantId === 'ZM-1' && !c.customerId, 'dossier relié au marchand Zentact, pas encore à Books');
  ok(c.status === 'draft' && c.amount === 2450.5 && /^MC-\d{8}-[0-9A-F]{4}$/.test(c.ref), 'brouillon créé, montant « 2 450,50 » lu');

  // Cloisonnement
  ok((await api('GET', `/api/credits/${c.id}`, 'autre@x.com')).status === 404, 'un autre rep ne voit pas le dossier');
  ok((await api('GET', '/api/credits', 'autre@x.com')).body.credits.length === 0, 'la liste d’un autre rep est vide');
  ok((await api('GET', '/api/credits', 'david@x.com')).body.credits.length === 1, 'l’approbateur voit tout');

  // Aperçu PDF du brouillon
  const pv = await api('GET', `/api/credits/${c.id}/pdf`, 'rep@x.com');
  ok(pv.status === 200 && pv.ct.includes('pdf') && pv.body.slice(0, 4).toString() === '%PDF', 'aperçu PDF du brouillon');

  // Pièce justificative (vrai multipart)
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('%PDF-1.4 pénalité Moneris 2 450,50 $')], { type: 'application/pdf' }), 'penalite.pdf');
  let r = await fetch(`${base}/api/credits/${c.id}/docs`, { method: 'POST', headers: { 'x-test-user': 'rep@x.com' }, body: fd });
  ok(r.status === 200, 'pièce téléversée');
  const fd2 = new FormData(); fd2.append('file', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'virus.exe');
  r = await fetch(`${base}/api/credits/${c.id}/docs`, { method: 'POST', headers: { 'x-test-user': 'rep@x.com' }, body: fd2 });
  ok(r.status === 400, 'type de fichier refusé');

  // Envoi
  const send = await api('POST', `/api/credits/${c.id}/send`, 'rep@x.com');
  ok(send.status === 200 && send.body.credit.status === 'sent', 'envoyé');
  const mail = mails.find((m) => m.to === 'owner@resto.ca');
  ok(mail && /credit-sign\?token=/.test(mail.html), 'courriel au client avec le lien');
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.html)[1];
  const stored = (await pool.query('SELECT token_hash, unsigned_sha FROM merchant_credits WHERE id=$1', [c.id])).rows[0];
  ok(stored.token_hash !== token && stored.token_hash === crypto.createHash('sha256').update(Buffer.from(token)).digest('hex'), 'seul le SHA-256 du jeton est gardé');
  ok((await api('PUT', `/api/credits/${c.id}`, 'rep@x.com', { amount: 99999 })).status === 409, 'plus modifiable une fois envoyé');
  ok((await api('POST', `/api/credits/${c.id}/approve`, 'david@x.com')).status === 409, 'pas d’approbation avant signature');

  // Page publique
  ok((await api('GET', '/api/public/credit-sign/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).status === 404, 'jeton inconnu');
  const info = (await api('GET', `/api/public/credit-sign/${token}`)).body;
  ok(info.status === 'viewed' && info.amount === 2450.5 && info.legalName.includes('Étoile'), 'le client ouvre : consulté');
  ok(info.email === 'owner@resto.ca' && info.phone === '514' && !('repEmail' in info), 'préremplissage : le courriel du destinataire seulement, jamais celui du rep');
  const pubPdf = await api('GET', `/api/public/credit-sign/${token}/pdf`);
  ok(crypto.createHash('sha256').update(pubPdf.body).digest('hex') === stored.unsigned_sha, 'le client lit EXACTEMENT le document haché à l’envoi');
  ok((await api('POST', `/api/public/credit-sign/${token}/sign`, null, { printName: 'Marie', title: 'Propriétaire', consent: true, signature: 'data:image/png;base64,AAAA' })).status === 400, 'signature vide refusée');
  ok((await api('POST', `/api/public/credit-sign/${token}/sign`, null, { printName: 'Marie', title: 'Propriétaire', consent: false, signature: fakeSignaturePng() })).status === 400, 'consentement obligatoire');
  // Le client remplit lui-même les infos du marchand
  const inc0 = await api('POST', `/api/public/credit-sign/${token}/sign`, null, { printName: 'Marie', title: 'Propriétaire', consent: true, signature: fakeSignaturePng(), legalName: 'Restaurants l’Étoile inc.', contactPerson: '', phone: '12', email: 'owner@resto.ca' });
  ok(inc0.status === 400 && inc0.body.missing.includes('contactPerson') && inc0.body.missing.includes('phone'), 'infos du marchand incomplètes : refusé, champs nommés');
  const prev = await api('POST', `/api/public/credit-sign/${token}/preview`, null, { legalName: 'Restaurants l’Étoile inc.', contactPerson: 'Marie-Ève Tremblay', phone: '514 555-0199', email: 'marie@resto.ca' });
  ok(prev.ct.includes('pdf') && prev.body.slice(0, 5).toString() === '%PDF-', 'aperçu PDF avec les valeurs saisies');
  // pièces du client : type vérifié dans les octets
  const up = async (name, buf, type) => { const fd = new FormData(); fd.append('file', new Blob([buf], { type }), name); const r = await fetch(`${base}/api/public/credit-sign/${token}/docs`, { method: 'POST', body: fd }); return { status: r.status, body: await r.json() }; };
  ok((await up('faux.pdf', Buffer.from('<html>pas un pdf</html>'), 'application/pdf')).body.error === 'bad_type', 'client : faux PDF refusé (octets vérifiés)');
  const upOk = await up('facture-penalite.pdf', Buffer.from('%PDF-1.4 fake pdf body for the test'), 'application/pdf');
  ok(upOk.status === 200 && upOk.body.docs.length === 1, 'client : pièce jointe');
  const up2 = await up('recu.pdf', Buffer.from('%PDF-1.4 second document here...'), 'application/pdf');
  ok((await api('DELETE', `/api/public/credit-sign/${token}/docs/${up2.body.docs[1].id}`)).body.docs.length === 1, 'client : retire sa pièce');
  ok((await api('GET', `/api/public/credit-sign/${token}`)).body.docs[0].filename === 'facture-penalite.pdf', 'la page revoit ses pièces');
  const signed = await api('POST', `/api/public/credit-sign/${token}/sign`, null, { printName: 'Marie-Ève Tremblay', title: 'Propriétaire', consent: true, signature: fakeSignaturePng(), legalName: 'Restaurants l’Étoile inc.', contactPerson: 'Marie-Ève Tremblay', phone: '514 555-0199', email: 'marie@resto.ca' });
  ok(signed.status === 200 && signed.body.status === 'signed', 'signé');
  const after = (await pool.query('SELECT contact_person, phone, email, unsigned_sha, unsigned_pdf FROM merchant_credits WHERE id=$1', [c.id])).rows[0];
  ok(after.contact_person === 'Marie-Ève Tremblay' && after.phone === '514 555-0199' && after.email === 'marie@resto.ca', 'les valeurs du client sont enregistrées');
  ok(after.unsigned_sha !== stored.unsigned_sha && crypto.createHash('sha256').update(Buffer.from(after.unsigned_pdf)).digest('hex') === after.unsigned_sha, 'document confirmé par le client figé et haché');
  ok((await pool.query(`SELECT 1 FROM activity_log WHERE entity_id=$1 AND event_type='client_edited' AND description LIKE '%téléphone%'`, [c.id])).rows.length === 1, 'les changements du client sont tracés');
  ok((await api('GET', `/api/credits/${c.id}`, 'rep@x.com')).body.docs.some((d) => d.filename === 'facture-penalite.pdf' && d.uploadedBy === 'client'), 'le rep voit la pièce du client');
  ok((await api('POST', `/api/public/credit-sign/${token}/sign`, null, { printName: 'X Y', title: 'Z', consent: true, signature: fakeSignaturePng() })).status === 409, 'on ne signe pas deux fois');
  const row = (await pool.query('SELECT commitment_end, signed_at, signed_pdf FROM merchant_credits WHERE id=$1', [c.id])).rows[0];
  const months = (new Date(row.commitment_end).getFullYear() - new Date(row.signed_at).getFullYear()) * 12 + (new Date(row.commitment_end).getMonth() - new Date(row.signed_at).getMonth());
  ok(months === 36, 'fin d’engagement = signature + 36 mois');
  ok(mails.some((m) => m.to.includes('marie@resto.ca') && m.to.includes('owner@resto.ca') && m.opts.attachments), 'copie signée : adresse confirmée ET adresse d’origine');
  ok(mails.some((m) => m.to.includes('david@x.com') && m.to.includes('rep@x.com')), 'avis au rep et à l’approbateur');

  // Approbation — Zoho refuse d'abord (permission manquante), puis accepte
  ok((await api('POST', `/api/credits/${c.id}/approve`, 'rep@x.com')).status === 403, 'le rep ne peut pas approuver');
  ok((await api('POST', `/api/credits/${c.id}/approve`, 'david@x.com')).body.error === 'books_customer_required', 'pas d’approbation sans compte Zoho Books relié');
  const books = (await api('GET', '/api/credits/customers?q=Etoile', 'david@x.com')).body.customers;
  ok(books.length === 1 && books[0].id === '4600001', 'l’approbateur cherche le compte Books');
  ok((await api('POST', `/api/credits/${c.id}/books-customer`, 'autre@x.com', { customerId: '4600001' })).status === 404, 'un autre rep ne peut pas relier le dossier');
  const linked = await api('POST', `/api/credits/${c.id}/books-customer`, 'david@x.com', { customerId: '4600001' });
  ok(linked.status === 200 && linked.body.credit.customerId === '4600001', 'compte Books relié');
  let ap = await api('POST', `/api/credits/${c.id}/approve`, 'david@x.com');
  ok(ap.status === 200 && ap.body.credit.status === 'approved' && !ap.body.books.ok && /creditnotes\.CREATE/.test(ap.body.credit.booksError), 'approuvé, Zoho refuse : erreur claire');
  ok((await api('POST', `/api/credits/${c.id}/approve`, 'david@x.com')).status === 409, 'pas de double approbation');
  booksMode = 'ok';
  ap = await api('POST', `/api/credits/${c.id}/retry-books`, 'david@x.com');
  ok(ap.body.books.ok && ap.body.credit.creditnoteNumber === 'CN-00042' && !ap.body.credit.booksError, 'réessai : note de crédit créée');
  ok(creditNotes.length === 1 && creditNotes[0].amount == 2450.5 && creditNotes[0].customerId === '4600001', 'Zoho reçoit le bon client et le bon montant');
  ok((await api('POST', `/api/credits/${c.id}/retry-books`, 'david@x.com')).status === 409, 'pas de seconde note de crédit');
  ok((await fetch(`${base}/api/credits/${c.id}/docs/1`, { method: 'DELETE', headers: { 'x-test-user': 'rep@x.com' } })).status === 409, 'pièces verrouillées après approbation');

  // Dossier sans pièce : approbation refusée
  let c2 = (await api('POST', '/api/credits', 'rep@x.com', { merchantId: 'ZM-2', legalName: 'B inc.', contactPerson: 'B', email: 'b@b.ca', amount: 100 })).body.credit;
  await api('POST', `/api/credits/${c2.id}/send`, 'rep@x.com');
  const t2 = /token=([A-Za-z0-9_-]+)/.exec(mails.filter((m) => m.to === 'b@b.ca').pop().html)[1];
  await api('POST', `/api/public/credit-sign/${t2}/sign`, null, { printName: 'B B', title: 'CEO', consent: true, signature: fakeSignaturePng(), legalName: 'B inc.', contactPerson: 'B B', phone: '514 555-0100', email: 'b@b.ca' });
  await api('POST', `/api/credits/${c2.id}/books-customer`, 'david@x.com', { customerId: '4600001' });
  ok((await api('POST', `/api/credits/${c2.id}/approve`, 'david@x.com')).body.error === 'docs_required', 'pas d’approbation sans pièce justificative');
  ok((await api('POST', `/api/credits/${c2.id}/reject`, 'david@x.com', {})).status === 400, 'refus : raison obligatoire');
  ok((await api('POST', `/api/credits/${c2.id}/reject`, 'david@x.com', { reason: 'Pièce manquante' })).body.credit.status === 'rejected', 'refusé avec raison');

  // Envoi incomplet
  const c3 = (await api('POST', '/api/credits', 'rep@x.com', { merchantId: 'ZM-1', legalName: 'C', contactPerson: '', email: 'pas-un-courriel', amount: 0 })).body.credit;
  const inc = await api('POST', `/api/credits/${c3.id}/send`, 'rep@x.com');
  ok(inc.status === 400 && inc.body.missing.includes('email') && inc.body.missing.includes('amount') && !inc.body.missing.includes('contactPerson'), 'envoi incomplet refusé, champs nommés (la personne-ressource est remplie par le client)');
  ok((await api('DELETE', `/api/credits/${c3.id}`, 'rep@x.com')).status === 200, 'brouillon supprimable');
  ok((await api('DELETE', `/api/credits/${c.id}`, 'rep@x.com')).status === 409, 'un dossier envoyé ne se supprime pas');

  // Reprise avant 36 mois
  const before = mails.length;
  let chk = await credits.checkClawbacks();
  ok(chk.flagged === 0, 'marchand actif : aucune reprise signalée');
  await pool.query(`UPDATE zentact_merchants SET status = 'CLOSED' WHERE merchant_account_id = 'ZM-1'`);
  chk = await credits.checkClawbacks();
  ok(chk.flagged === 1 && chk.alerted === 1, 'marchand fermé avant 36 mois : reprise signalée, avis envoyé');
  ok(mails.length === before + 1 && mails[mails.length - 1].to.includes('david@x.com') && /Reprise possible/.test(mails[mails.length - 1].subject), 'avis de reprise à l’approbateur');
  chk = await credits.checkClawbacks();
  ok(chk.flagged === 0 && chk.alerted === 0 && mails.length === before + 1, 'un seul avis, jamais répété');
  let det = (await api('GET', `/api/credits/${c.id}`, 'david@x.com')).body.credit;
  ok(det.clawback && det.clawback.status === 'flagged' && det.clawback.zentactStatus === 'CLOSED', 'le dossier porte l’alerte');
  ok((await api('POST', `/api/credits/${c.id}/clawback`, 'rep@x.com', { decision: 'reclaimed' })).status === 403, 'le rep ne tranche pas la reprise');
  ok((await api('POST', `/api/credits/${c.id}/clawback`, 'david@x.com', { decision: 'n_importe' })).status === 400, 'décision invalide refusée');
  det = (await api('POST', `/api/credits/${c.id}/clawback`, 'david@x.com', { decision: 'reclaimed', note: 'Facturé sur la dernière facture' })).body.credit;
  ok(det.clawback.status === 'reclaimed' && det.clawback.decidedBy === 'david@x.com', 'reprise tranchée et tracée');
  ok((await api('POST', `/api/credits/${c.id}/clawback`, 'david@x.com', { decision: 'waived' })).status === 409, 'on ne tranche pas deux fois');
  // un engagement déjà terminé ne se reprend plus
  await pool.query(`UPDATE merchant_credits SET clawback_status = NULL, commitment_end = CURRENT_DATE - 1 WHERE id = $1`, [c.id]);
  ok((await credits.checkClawbacks()).flagged === 0, 'engagement terminé : pas de reprise');

  server.close();
  console.log(`credits : ${n} vérifications OK`);
})().catch((e) => { console.error('ÉCHEC', e); process.exit(1); });
