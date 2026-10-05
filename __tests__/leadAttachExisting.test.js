// Rattacher une piste a un marchand qui existe deja dans Zoho (2026-10-05).
//
// Le code teste est EXTRAIT de server.js, pas recopie : un test ecrit contre une copie valide
// une copie. server.js fait 38 000 lignes et n'est pas importable (il demarre un serveur et se
// connecte a la base des l'import), donc on en decoupe les fonctions et on les evalue avec des
// doublures.
//
// Ce qui compte ici, et pourquoi :
//   1. `resolveAttachTarget` est la SEULE barriere entre un identifiant venu du navigateur et la
//      creation d'une opportunite dans Zoho. Sans elle, on peut accrocher une affaire a
//      n'importe quel compte de l'organisation, au nom de n'importe quel representant.
//   2. `leadDealStage` doit envoyer une etape CONFIGUREE telle quelle, meme absente des
//      metadonnees de Zoho — celles-ci mentent, et les avoir crues a deja coute deux incidents
//      (voir le commentaire de `Lead_Status: 'New'` dans server.js).
const { monter } = require('../test-utils/extraireDeServer');

const COMPTE = { module: 'Accounts', id: '111', name: 'Le Cambo' };
const CONTACT = { module: 'Contacts', id: '222', name: 'Luoy Eoang' };
const PISTE = { crm_match_records: [COMPTE, CONTACT, { module: 'Leads', id: '333', name: 'Le Cambo' }] };

function bacAvecContact(contact) {
  const appels = [];
  const bac = monter(['resolveAttachTarget', 'leadDealStage'], {
    ensureValidCrmToken: async () => 'jeton',
    axios: {
      async get(url) {
        appels.push(url);
        return contact === null
          ? { status: 404, data: {} }
          : { status: 200, data: { data: [contact] } };
      },
    },
  });
  bac.__appels = appels;
  return bac;
}

describe('resolveAttachTarget — la barriere', () => {
  // ── TEMOIN POSITIF ───────────────────────────────────────────────────────────────────────
  // Sans lui, tous les tests de refus passeraient aussi avec une fonction qui refuse TOUT.
  test('temoin : un compte trouve par la detection est accepte', async () => {
    const bac = bacAvecContact(null);
    const out = await bac.resolveAttachTarget(PISTE, { module: 'Accounts', id: '111' });
    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({ accountId: '111', accountName: 'Le Cambo', contactId: null });
  });

  test('un identifiant ABSENT des resultats de la detection est refuse', async () => {
    const bac = bacAvecContact(null);
    // Un compte qui existe peut-etre dans Zoho, mais que rien ne relie a CETTE piste.
    const out = await bac.resolveAttachTarget(PISTE, { module: 'Accounts', id: '999' });
    expect(out).toEqual({ error: 'attach_unknown' });
  });

  test('le bon identifiant dans le MAUVAIS module est refuse', async () => {
    const bac = bacAvecContact(null);
    const out = await bac.resolveAttachTarget(PISTE, { module: 'Accounts', id: '222' });
    expect(out).toEqual({ error: 'attach_unknown' });
  });

  test('une piste sans resultats de detection n’accepte rien', async () => {
    const bac = bacAvecContact(null);
    for (const sansRien of [{}, { crm_match_records: null }, { crm_match_records: [] }]) {
      const out = await bac.resolveAttachTarget(sansRien, { module: 'Accounts', id: '111' });
      expect(out).toEqual({ error: 'attach_unknown' });
    }
  });

  test('module ou identifiant manquant : refus avant tout appel a Zoho', async () => {
    const bac = bacAvecContact(null);
    for (const mauvais of [null, {}, { module: 'Accounts' }, { id: '111' }, { module: '', id: '' }]) {
      expect(await bac.resolveAttachTarget(PISTE, mauvais)).toEqual({ error: 'attach_invalid' });
    }
    expect(bac.__appels).toHaveLength(0);
  });

  test('un Lead homonyme n’est pas un marchand', async () => {
    const bac = bacAvecContact(null);
    const out = await bac.resolveAttachTarget(PISTE, { module: 'Leads', id: '333' });
    expect(out).toEqual({ error: 'attach_not_a_customer' });
  });
});

describe('resolveAttachTarget — un contact', () => {
  test('le compte est lu SUR le contact, et les deux sont renvoyes', async () => {
    const bac = bacAvecContact({ id: '222', Full_Name: 'Luoy Eoang', Account_Name: { id: '111', name: 'Le Cambo' } });
    const out = await bac.resolveAttachTarget(PISTE, { module: 'Contacts', id: '222' });
    expect(out).toEqual({ accountId: '111', accountName: 'Le Cambo', contactId: '222', contactName: 'Luoy Eoang' });
    expect(bac.__appels[0]).toContain('/Contacts/222');
  });

  test('un contact SANS compte est refuse — on n’invente pas de compte', async () => {
    const bac = bacAvecContact({ id: '222', Full_Name: 'Luoy Eoang' });
    expect(await bac.resolveAttachTarget(PISTE, { module: 'Contacts', id: '222' }))
      .toEqual({ error: 'attach_no_account' });
  });

  test('un contact illisible est refuse, pas devine', async () => {
    const bac = bacAvecContact(null);
    expect(await bac.resolveAttachTarget(PISTE, { module: 'Contacts', id: '222' }))
      .toEqual({ error: 'attach_unreadable' });
  });

  test('Zoho injoignable : refus, jamais d’exception qui remonte', async () => {
    const bac = monter(['resolveAttachTarget', 'leadDealStage'], {
      ensureValidCrmToken: async () => { throw new Error('reseau'); },
      axios: { get: async () => ({ status: 200, data: {} }) },
    });
    const out = await bac.resolveAttachTarget(PISTE, { module: 'Contacts', id: '222' });
    expect(out.error).toBe('attach_unreadable');
  });
});

describe('leadDealStage', () => {
  // LE test de cette fonction. Les metadonnees de Zoho omettent des valeurs pourtant valides ;
  // filtrer la consigne de l'admin contre cette liste rejouerait l'incident de `Lead_Status`.
  test('une etape configuree part TELLE QUELLE, meme absente des metadonnees', async () => {
    const bac = monter(['resolveAttachTarget', 'leadDealStage'], { crmDealStages: async () => ['Qualification', 'Negotiation'] });
    expect(await bac.leadDealStage({ dealStage: 'Discovery — POS' })).toBe('Discovery — POS');
  });

  test('sans consigne, on prend la premiere etape annoncee par Zoho', async () => {
    const bac = monter(['resolveAttachTarget', 'leadDealStage'], { crmDealStages: async () => ['Qualification', 'Negotiation'] });
    expect(await bac.leadDealStage({ dealStage: '' })).toBe('Qualification');
    expect(await bac.leadDealStage({})).toBe('Qualification');
  });

  test('sans consigne ET sans metadonnees : null, pour s’arreter AVANT d’ecrire', async () => {
    const bac = monter(['resolveAttachTarget', 'leadDealStage'], { crmDealStages: async () => [] });
    expect(await bac.leadDealStage({})).toBeNull();
  });

  test('les espaces autour d’une consigne ne la transforment pas en absence', async () => {
    const bac = monter(['resolveAttachTarget', 'leadDealStage'], { crmDealStages: async () => ['Qualification'] });
    expect(await bac.leadDealStage({ dealStage: '   ' })).toBe('Qualification');
  });
});
