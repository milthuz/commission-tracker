// Les deux chemins NEUFS du rattachement a un marchand existant (2026-10-05) : le rappel
// accroche a une opportunite, et l'ecriture de l'opportunite elle-meme.
//
// Aucun des deux n'a jamais touche le vrai Zoho — meme reserve que le reste des ecritures CRM de
// ce depot. Ces tests ne prouvent donc pas que Zoho accepte ; ils prouvent que NOTRE moitie du
// contrat est correcte : le bon champ de liaison, le bon module, le bon repli, et aucun faux
// succes. Le code teste est EXTRAIT de server.js, pas recopie (voir test-utils).
const { monter } = require('../test-utils/extraireDeServer');

// ── Le rappel ───────────────────────────────────────────────────────────────────────────────
// Sur un Lead, `Who_Id` et `What_Id` se remplacent. Sur un Deal, `What_Id` designe le DOSSIER et
// `Who_Id` le CONTACT : les deux coexistent. Se tromper donne un rappel qui existe dans Zoho mais
// ne pend a rien — invisible exactement la ou le representant le cherche.
function bacRappel(reponses) {
  const envois = [];
  let n = 0;
  const bac = monter('scheduleLeadCallback', {
    ensureValidCrmToken: async () => 'jeton',
    tzParts: () => ({ year: 2026, month: 10, day: 6, hour: 10, minute: 30 }),
    tzOffsetString: () => '-04:00',
    axios: {
      async post(url, corps) {
        envois.push({ url, enr: corps.data[0] });
        return reponses[n++]
          ? { status: 201, data: { data: [{ status: 'success', details: { id: 'cb1' } }] } }
          : { status: 400, data: { data: [{ status: 'error', message: 'refus de Zoho' }] } };
      },
    },
  });
  bac.__envois = envois;
  return bac;
}

const PISTE = { business_name: 'Le Cambo', ref_code: 'L-00011', source: 'website',
                contact_phone: '4507571402', contact_email: 'x@y.ca' };
const REGLAGES = { callbackType: 'call' };
const champLien = (enr) => Object.keys(enr).filter((k) => k === 'Who_Id' || k === 'What_Id');

describe('scheduleLeadCallback — viser le bon dossier', () => {
  test('sur un Deal : What_Id d’abord, et le contact en Who_Id A COTE', async () => {
    const bac = bacRappel([true]);
    const out = await bac.scheduleLeadCallback(PISTE, { crmUserId: 'u1' },
      { module: 'Deals', id: 'D1', contactId: 'C1' }, new Date(), REGLAGES);
    expect(out).toMatchObject({ ok: true, linkField: 'What_Id' });
    expect(bac.__envois).toHaveLength(1);
    const enr = bac.__envois[0].enr;
    expect(enr.$se_module).toBe('Deals');
    expect(enr.What_Id).toEqual({ id: 'D1' });
    expect(enr.Who_Id).toEqual({ id: 'C1' });          // les DEUX, pas l'un OU l'autre
    expect(enr.Owner).toEqual({ id: 'u1' });
  });

  test('sur un Deal sans contact : What_Id seul, jamais un Who_Id vide', async () => {
    const bac = bacRappel([true]);
    await bac.scheduleLeadCallback(PISTE, {}, { module: 'Deals', id: 'D1', contactId: null },
      new Date(), REGLAGES);
    expect(champLien(bac.__envois[0].enr)).toEqual(['What_Id']);
  });

  test('sur un Lead : l’ordre historique est INTACT (Who_Id d’abord)', async () => {
    const bac = bacRappel([true]);
    const out = await bac.scheduleLeadCallback(PISTE, {}, { module: 'Leads', id: 'L1' },
      new Date(), REGLAGES);
    expect(out.linkField).toBe('Who_Id');
    expect(bac.__envois[0].enr.$se_module).toBe('Leads');
    expect(bac.__envois[0].enr.Who_Id).toEqual({ id: 'L1' });
  });

  test('premier champ refuse : bascule sur l’autre, et la forme retenue est rapportee', async () => {
    const bac = bacRappel([false, true]);
    const out = await bac.scheduleLeadCallback(PISTE, {}, { module: 'Deals', id: 'D1' },
      new Date(), REGLAGES);
    expect(out).toMatchObject({ ok: true, linkField: 'Who_Id' });
    expect(bac.__envois.map((e) => champLien(e.enr)[0])).toEqual(['What_Id', 'Who_Id']);
  });

  test('les deux refuses : echec rapporte, jamais un faux succes', async () => {
    const bac = bacRappel([false, false]);
    const out = await bac.scheduleLeadCallback(PISTE, {}, { module: 'Deals', id: 'D1' },
      new Date(), REGLAGES);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('refus de Zoho');
  });

  test('un module inattendu retombe sur Leads au lieu de partir tel quel', async () => {
    const bac = bacRappel([true]);
    await bac.scheduleLeadCallback(PISTE, {}, { module: 'Comptes', id: 'X' }, new Date(), REGLAGES);
    expect(bac.__envois[0].enr.$se_module).toBe('Leads');
  });
});

// ── L'ecriture de l'opportunite ─────────────────────────────────────────────────────────────
function bacDeal({ posts = [] } = {}) {
  const appels = { post: [], put: [], get: [] };
  let n = 0;
  const bac = monter('createCrmDealOnAccount', {
    crmTokenForActor: async () => ({ token: 'perso', actingAs: 'gabriella@x.ca' }),
    crmSystemAccount: async () => 'sys@x.ca',
    ensureValidCrmToken: async () => 'systeme',
    axios: {
      async post(url, corps) {
        appels.post.push({ url, corps });
        if (url.endsWith('/Notes')) return { status: 201, data: { data: [{ status: 'success' }] } };
        return posts[n++] || { status: 201, data: { data: [{ status: 'success', details: { id: 'D9' } }] } };
      },
      async put(url, corps) { appels.put.push({ url, corps }); return { status: 200, data: {} }; },
      async get(url) { appels.get.push(url); return { status: 200, data: { data: [{ Owner: { id: 'u1', name: 'Jay' } }] } }; },
    },
  });
  bac.__appels = appels;
  return bac;
}

const DEAL = { deal_name: 'Le Cambo — L-00011', account_id: '111', contact_id: '222',
               stage: 'Qualification', closing_date: '2026-11-04', lead_source: 'Website',
               crm_owner_id: 'u1', approver_email: 'david@x.ca', description: 'contexte',
               note_title: 'Piste L-00011', note_body: 'contexte' };
const creations = (bac) => bac.__appels.post.filter((a) => !a.url.endsWith('/Notes'));

describe('createCrmDealOnAccount', () => {
  test('temoin : l’opportunite part avec son compte, son contact, son etape et sa date', async () => {
    const bac = bacDeal();
    expect(await bac.createCrmDealOnAccount(DEAL)).toEqual({ success: true, dealId: 'D9' });
    expect(creations(bac)[0].corps.data[0]).toMatchObject({
      Deal_Name: 'Le Cambo — L-00011',
      Account_Name: { id: '111' },
      Contact_Name: { id: '222' },
      Stage: 'Qualification',
      Closing_Date: '2026-11-04',
      Owner: { id: 'u1' },
    });
  });

  test('le proprietaire est REPOSE apres coup sans declencher les flux, puis RELU', async () => {
    // Les flux de l'organisation reecrivent le proprietaire a la creation — vecu sur les Leads le
    // 2026-09-03. Sans ce second passage, la piste finirait au nom de quelqu'un d'autre, et la
    // relecture est ce qui a revele le probleme la premiere fois.
    const bac = bacDeal();
    await bac.createCrmDealOnAccount(DEAL);
    expect(bac.__appels.put).toHaveLength(1);
    expect(bac.__appels.put[0].url).toContain('/Deals/D9');
    expect(bac.__appels.put[0].corps).toEqual({ data: [{ Owner: { id: 'u1' } }], trigger: [] });
    expect(bac.__appels.get.some((u) => u.includes('/Deals/D9'))).toBe(true);
  });

  test('un champ sacrifiable refuse est retire, puis on reessaie UNE seule fois', async () => {
    const bac = bacDeal({ posts: [
      { status: 400, data: { data: [{ status: 'error', code: 'INVALID_DATA', details: { api_name: 'Lead_Source' } }] } },
      { status: 201, data: { data: [{ status: 'success', details: { id: 'D9' } }] } },
    ] });
    expect((await bac.createCrmDealOnAccount(DEAL)).success).toBe(true);
    const essais = creations(bac);
    expect(essais).toHaveLength(2);
    expect(essais[1].corps.data[0]).not.toHaveProperty('Lead_Source');
    expect(essais[1].corps.data[0].Account_Name).toEqual({ id: '111' }); // le reste est intact
  });

  test('le compte, l’etape et la date ne sont JAMAIS sacrifies', async () => {
    // Les abandonner donnerait une opportunite orpheline ou sans etape — pire qu'un echec visible.
    for (const champ of ['Account_Name', 'Stage', 'Closing_Date']) {
      const bac = bacDeal({ posts: [
        { status: 400, data: { data: [{ status: 'error', code: 'INVALID_DATA', details: { api_name: champ } }] } },
      ] });
      const out = await bac.createCrmDealOnAccount(DEAL);
      expect(out.success).toBe(false);
      expect(out.error).toContain(champ);
      expect(creations(bac)).toHaveLength(1);        // aucun reessai
    }
  });

  test('jeton personnel refuse : repli sur le compte systeme plutot qu’echec', async () => {
    // Le profil Zoho d'une representante peut n'avoir aucun acces API (vecu le 2026-09-03).
    // Creer l'opportunite est le travail ; l'attribution n'est qu'un confort.
    const bac = bacDeal({ posts: [
      { status: 403, data: { code: 'NO_PERMISSION' } },
      { status: 201, data: { data: [{ status: 'success', details: { id: 'D9' } }] } },
    ] });
    expect(await bac.createCrmDealOnAccount(DEAL)).toEqual({ success: true, dealId: 'D9' });
    expect(creations(bac).length).toBeGreaterThanOrEqual(2);
  });

  test('la note est attachee au DEAL, pas a un Lead', async () => {
    const bac = bacDeal();
    await bac.createCrmDealOnAccount(DEAL);
    const note = bac.__appels.post.find((a) => a.url.endsWith('/Notes'));
    expect(note).toBeTruthy();
    expect(note.corps.data[0]).toMatchObject({ Parent_Id: { id: 'D9' }, se_module: 'Deals' });
  });

  test('sans contact, Contact_Name est absent — pas un objet vide', async () => {
    const bac = bacDeal();
    await bac.createCrmDealOnAccount({ ...DEAL, contact_id: null });
    expect(creations(bac)[0].corps.data[0]).not.toHaveProperty('Contact_Name');
  });

  test('refus de Zoho : le champ fautif est NOMME dans l’erreur', async () => {
    const bac = bacDeal({ posts: [
      { status: 400, data: { data: [{ status: 'error', code: 'INVALID_DATA', message: 'invalid data',
                                      details: { api_name: 'Closing_Date', expected_data_type: 'date' } }] } },
    ] });
    const out = await bac.createCrmDealOnAccount(DEAL);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Closing_Date/);
    expect(out.error).toMatch(/date/);
  });

  test('une exception reseau ne remonte pas : elle devient un echec rapporte', async () => {
    const bac = bacDeal();
    bac.axios.post = async () => { throw new Error('socket hang up'); };
    const out = await bac.createCrmDealOnAccount(DEAL);
    expect(out).toMatchObject({ success: false });
    expect(out.error).toContain('socket hang up');
  });
});
