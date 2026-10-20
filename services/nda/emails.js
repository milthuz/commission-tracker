// ============================================================================
// NDA — courriels. Constructeurs purs (sujet + HTML), partagés avec l'aperçu d'Admin →
// Notifications (sampleEmail dans server.js).
//
// L'autre partie reçoit la marque CLUSTER (`cluster-plain`), sans « Sales Hub » : elle fait
// affaire avec Cluster, pas avec un outil interne. Bilingues, la langue de l'entente d'abord.
// Les avis internes gardent la marque Sales Hub.
// ============================================================================

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SEP = '<hr style="border:none;border-top:1px solid #e2e8f0;margin:22px 0">';
const SECOND = (html) => `<div style="color:#64748b">${html}</div>`;
// Deux blocs, celui de la langue de l'entente en premier.
const both = (lang, fr, en) => (lang === 'en' ? `<div lang="en">${en}</div>${SEP}${SECOND(`<div lang="fr">${fr}</div>`)}` : `<div lang="fr">${fr}</div>${SEP}${SECOND(`<div lang="en">${en}</div>`)}`);
// « Inc. » en fin de phrase : la phrase fournit le point.
const endName = (s) => String(s || '').replace(/\.$/, '');
const pair = (lang, fr, en) => (lang === 'en' ? `${en} / ${fr}` : `${fr} / ${en}`);

// À l'autre partie. d = { lang, firstName, company, senderName, purpose, link, expiresDays }
function signRequestEmail(mailShell, d) {
  const subject = pair(d.lang, `Entente de confidentialité à signer — Cluster × ${d.company}`, `Non-disclosure agreement to sign — Cluster × ${d.company}`);
  const intro = both(d.lang,
    `<p style="margin:0 0 12px">Bonjour ${esc(d.firstName)},</p>
     <p style="margin:0 0 12px">${esc(d.senderName)}, de Cluster, vous transmet une entente de confidentialité mutuelle entre Cluster et <b>${esc(endName(d.company))}</b>.</p>
     <p style="margin:0 0 12px">Le bouton ci-dessous ouvre l’entente : lisez-la, puis signez directement à l’écran. Aucun logiciel ni compte n’est nécessaire. Cluster la contresignera ensuite et vous recevrez la copie signée par courriel.</p>
     <p style="margin:0">Ce lien vous est personnel et expire dans ${esc(d.expiresDays)} jours.</p>`,
    `<p style="margin:0 0 12px">Hi ${esc(d.firstName)},</p>
     <p style="margin:0 0 12px">${esc(d.senderName)} from Cluster is sending you a mutual non-disclosure agreement between Cluster and <b>${esc(endName(d.company))}</b>.</p>
     <p style="margin:0 0 12px">The button below opens the agreement: read it, then sign right on screen. No software or account is needed. Cluster will then countersign and you will receive the signed copy by email.</p>
     <p style="margin:0">This link is personal to you and expires in ${esc(d.expiresDays)} days.</p>`);
  return {
    subject,
    html: mailShell(pair(d.lang, 'Entente de confidentialité', 'Non-disclosure agreement'), intro,
      pair(d.lang, 'Consulter et signer', 'Review and sign'), d.link, undefined, 'cluster-plain'),
  };
}

// Aux personnes EN COPIE : avis d'envoi, sans le lien de signature (il est personnel).
// d = { lang, company, senderName, signerName, signerEmail }
function ccNoticeEmail(mailShell, d) {
  const subject = pair(d.lang, `Copie — NDA envoyé pour signature — Cluster × ${d.company}`, `Copy — NDA sent for signature — Cluster × ${d.company}`);
  const intro = both(d.lang,
    `<p style="margin:0 0 12px">${esc(d.senderName)}, de Cluster, a envoyé une entente de confidentialité mutuelle entre Cluster et <b>${esc(endName(d.company))}</b> à ${esc(d.signerName)} (${esc(d.signerEmail)}) pour signature.</p>
     <p style="margin:0">Vous êtes en copie : vous recevrez l’exemplaire signé par les deux parties dès qu’il sera complété.</p>`,
    `<p style="margin:0 0 12px">${esc(d.senderName)} from Cluster sent a mutual non-disclosure agreement between Cluster and <b>${esc(endName(d.company))}</b> to ${esc(d.signerName)} (${esc(d.signerEmail)}) for signature.</p>
     <p style="margin:0">You are copied: you will receive the copy signed by both parties as soon as it is complete.</p>`);
  return { subject, html: mailShell(pair(d.lang, 'Entente de confidentialité', 'Non-disclosure agreement'), intro, null, null, undefined, 'cluster-plain') };
}

// Interne, au signataire de Cluster. d = { company, signerName, link }
function countersignEmail(mailShell, d) {
  const subject = `✍️ NDA ${d.company} — contresignature requise / countersignature needed`;
  const intro = `<p style="margin:0 0 12px"><b>${esc(d.signerName)}</b> a signé l’entente de confidentialité pour <b>${esc(endName(d.company))}</b>. Il reste à la contresigner pour Cluster.</p>
    <p style="margin:0;color:#64748b"><b>${esc(d.signerName)}</b> signed the non-disclosure agreement for <b>${esc(endName(d.company))}</b>. It now needs Cluster’s countersignature.</p>`;
  return { subject, html: mailShell('Contresignature requise · Countersignature needed', intro, 'Ouvrir / Open', d.link) };
}

// À l'autre partie, NDA signé en pièce jointe. d = { lang, firstName, company }
function completedPartyEmail(mailShell, d) {
  const subject = pair(d.lang, `Entente de confidentialité signée — Cluster × ${d.company}`, `Signed non-disclosure agreement — Cluster × ${d.company}`);
  const intro = both(d.lang,
    `<p style="margin:0 0 12px">Bonjour ${esc(d.firstName)},</p>
     <p style="margin:0">L’entente de confidentialité entre Cluster et ${esc(d.company)} est maintenant signée par les deux parties. Vous trouverez l’exemplaire signé en pièce jointe — conservez-le.</p>`,
    `<p style="margin:0 0 12px">Hi ${esc(d.firstName)},</p>
     <p style="margin:0">The non-disclosure agreement between Cluster and ${esc(d.company)} is now signed by both parties. The signed copy is attached — please keep it for your records.</p>`);
  return { subject, html: mailShell(pair(d.lang, 'Entente signée', 'Agreement signed'), intro, null, null, undefined, 'cluster-plain') };
}

// Interne, NDA signé en pièce jointe. d = { company, link }
function completedInternalEmail(mailShell, d) {
  const subject = `✅ NDA ${d.company} — signé / signed`;
  const intro = `<p style="margin:0 0 12px">L’entente de confidentialité avec <b>${esc(d.company)}</b> est signée par les deux parties. Elle est jointe à ce courriel et reste disponible dans Sales Hub → NDA.</p>
    <p style="margin:0;color:#64748b">The non-disclosure agreement with <b>${esc(d.company)}</b> is fully signed. It is attached and remains available in Sales Hub → NDA.</p>`;
  return { subject, html: mailShell('NDA signé · NDA signed', intro, 'Ouvrir / Open', d.link) };
}

// Interne. d = { company, signerName, reason, link }
function declinedEmail(mailShell, d) {
  const subject = `⛔ NDA ${d.company} — refusé / declined`;
  const reason = d.reason ? `<p style="margin:0 0 12px;padding:10px 14px;background:#f8fafc;border-left:3px solid #cbd5e1">${esc(d.reason)}</p>` : '';
  const intro = `<p style="margin:0 0 12px"><b>${esc(d.signerName)}</b> (${esc(d.company)}) a refusé de signer l’entente de confidentialité. / declined to sign the non-disclosure agreement.</p>${reason}`;
  return { subject, html: mailShell('NDA refusé · NDA declined', intro, 'Ouvrir / Open', d.link) };
}

module.exports = { signRequestEmail, ccNoticeEmail, countersignEmail, completedPartyEmail, completedInternalEmail, declinedEmail, esc };
