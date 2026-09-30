// Document v2 des crédits processeur marchand : contenu, échappement, repli sur l'ancien gabarit.
// node services/credits/__tests__/html.test.js
const assert = require('assert');
const { renderCreditHtml } = require('../html');
const pdf = require('../pdf');

let n = 0; const ok = (c, m) => { assert(c, m); n++; };
const visible = (html) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ');

(async () => {
  const c = { ref: 'MC-1', lang: 'fr', legal_name: 'Resto <script>alert(1)</script> & fils', contact_person: 'Julie "JR" Roy', phone: '450 555-0142', email: 'j@r.ca', amount: 1850 };

  const u = renderCreditHtml(c, { docs: ['facture.pdf'] });
  ok(!u.includes('<script>alert'), 'le HTML saisi est échappé');
  ok(visible(u).includes('Resto &lt;script&gt;alert(1)&lt;/script&gt; &amp; fils'), 'le nom légal figure, échappé');
  ok(visible(u).includes('1 850,00 $'), 'montant au format québécois');
  ok(visible(u).includes('36 mois'), 'engagement de 36 mois par défaut');
  ok(visible(u).includes('facture.pdf'), 'les pièces jointes sont listées');
  ok(visible(u).includes('Aperçu — non signé') && !u.includes('Certificat de signature'), 'non signé : pas de certificat, zone marquée aperçu');
  ok(!/\{m\}|undefined|NaN/.test(visible(u)), 'aucun gabarit ni valeur manquante à l’écran');

  const sig = { name: 'Julie Roy', title: 'Propriétaire', at: '2026-09-30T15:00:00Z', ip: '203.0.113.7', ua: 'UA', image: 'data:image/png;base64,iVBORw0KGgo=' };
  const s = renderCreditHtml(c, { sig, sha: 'f'.repeat(64), commitmentMonths: 24 });
  ok(s.includes('Certificat de signature électronique') && s.includes('f'.repeat(64)), 'signé : certificat avec l’empreinte');
  ok(s.includes('<img src="data:image/png;base64,iVBORw0KGgo="'), 'image de signature posée');
  ok(visible(s).includes('24 mois'), 'durée d’engagement reprise');
  const bad = renderCreditHtml(c, { sig: { ...sig, image: 'javascript:alert(1)' } });
  ok(!bad.includes('javascript:alert'), 'une image qui n’est pas un PNG data: est refusée');

  const en = renderCreditHtml({ ...c, lang: 'en' }, {});
  ok(visible(en).includes('$1,850.00') && visible(en).includes('Merchant Compensation Credit'), 'anglais');

  // Repli : service de rendu en panne → l'ancien gabarit, jamais d'échec
  pdf.setHtmlRenderer(async () => { throw new Error('render_failed_502'); });
  const warn = console.warn; console.warn = () => {};
  const fb = await pdf.renderUnsigned({ ...c, legal_name: 'Resto' }, {});
  console.warn = warn;
  ok(fb.slice(0, 5).toString() === '%PDF-', 'rendu en panne : PDF de l’ancien gabarit');
  // Service disponible : c'est son PDF qui sert, construit depuis le HTML v2
  let seen = '';
  pdf.setHtmlRenderer(async (html) => { seen = html; return Buffer.concat([Buffer.from('%PDF-1.7 v2 '), Buffer.alloc(2000)]); });
  const v2 = await pdf.renderSigned({ ...c }, sig, 'a'.repeat(64), { docs: ['recu.png'] });
  ok(v2.slice(0, 12).toString() === '%PDF-1.7 v2 ' && seen.includes('recu.png') && seen.includes('a'.repeat(64)), 'rendu disponible : document v2');

  console.log(`credits html : ${n} vérifications OK`);
})().catch((e) => { console.error(e); process.exit(1); });
