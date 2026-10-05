// L'invariant qui manquait le 2026-10-05.
//
// `leadAccess()` calcule ce que la personne a le droit de faire ; les trois reponses de l'API
// enumeraient ensuite leurs cles A LA MAIN. J'ai ajoute `attachExisting` a leadAccess et oublie
// de l'ajouter aux reponses : le bouton « Rattacher » ne s'est JAMAIS affiche, sans la moindre
// erreur — ni au serveur, ni au navigateur, ni dans mes 29 tests, qui testaient les fonctions
// et pas ce que l'API envoie.
//
// Deux garde-fous, donc :
//   1. TOUTE capacite calculee par leadAccess doit ressortir par leadCan ;
//   2. aucune reponse ne doit reconstruire un `can` a la main — sinon le garde-fou 1 ne protege
//      que le chemin qu'on a pense a emprunter.
const fs = require('fs');
const path = require('path');
const { monter, source } = require('../test-utils/extraireDeServer');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// `leadCan` est une fonction SYNCHRONE : l'extracteur partage ne decoupe que les `async`.
function monterLeadCan() {
  const vm = require('vm');
  const debut = SOURCE.indexOf('function leadCan(acc) {');
  if (debut === -1) throw new Error('leadCan introuvable dans server.js');
  const fin = SOURCE.indexOf('\n}', debut);
  const bac = {};
  vm.createContext(bac);
  vm.runInContext(SOURCE.slice(debut, fin + 2), bac);
  return bac.leadCan;
}

async function capacites({ isAdmin = false, perms = [] } = {}) {
  const bac = monter('leadAccess', {
    getUserPermissions: async () => new Set(perms),
    userHasPermission: (set, p) => set.has(p) || set.has('*'),
  });
  return bac.leadAccess({ user: { isAdmin, email: 'x@y.ca' } });
}

describe('les capacites des pistes arrivent bien a l’ecran', () => {
  test('temoin : leadAccess rend bien un objet de capacites', async () => {
    const acc = await capacites({ isAdmin: true });
    expect(Object.keys(acc).length).toBeGreaterThan(5);
    expect(acc.review).toBe(true);
  });

  test('TOUTE capacite calculee ressort par leadCan', async () => {
    const acc = await capacites({ isAdmin: true });
    const can = monterLeadCan()(acc);
    const manquantes = Object.keys(acc).filter((k) => !(k in can));
    expect(manquantes).toEqual([]);
  });

  test('`delete` est expose sous son nom naturel, pas seulement `remove`', async () => {
    const acc = await capacites({ isAdmin: true });
    const can = monterLeadCan()(acc);
    expect(can.delete).toBe(acc.remove);
  });

  test('le cas qui a casse : `attachExisting` traverse jusqu’a l’ecran', async () => {
    const admin = monterLeadCan()(await capacites({ isAdmin: true }));
    expect(admin.attachExisting).toBe(true);
    // Et il ne s'allume PAS tout seul : sans la permission, il reste faux.
    const simple = monterLeadCan()(await capacites({ perms: ['leads:review'] }));
    expect(simple.attachExisting).toBe(false);
    expect(simple.review).toBe(true);
  });

  // TEMOIN NEGATIF — un garde-fou qui n'a jamais vu le defaut ne prouve rien. On rejoue ici
  // l'ancienne enumeration manuelle et on verifie que l'assertion du dessus l'aurait ATTRAPEE.
  test('temoin : l’ancienne version manuelle serait refusee', async () => {
    const acc = await capacites({ isAdmin: true });
    const ancien = (a) => ({ review: a.review, delete: a.remove, toTicket: a.toTicket });
    const manquantes = Object.keys(acc).filter((k) => !(k in ancien(acc)));
    expect(manquantes).toContain('attachExisting');   // le bouton « Rattacher »
    expect(manquantes.length).toBeGreaterThan(0);
  });

  test('aucune reponse ne reconstruit un `can` a la main', () => {
    // C'est l'enumeration manuelle qui a cause le bogue. Si quelqu'un en reecrit une, le
    // garde-fou du dessus ne la couvrira pas — alors on l'interdit ici.
    const aLaMain = SOURCE.match(/can:\s*\{/g) || [];
    expect(aLaMain).toEqual([]);
    // Temoin : le motif saurait en trouver une s'il y en avait une.
    expect('      can: { review: acc.review },'.match(/can:\s*\{/g)).toHaveLength(1);
    // Et les trois reponses passent bien par le point unique.
    expect((SOURCE.match(/can: leadCan\(acc\)/g) || []).length).toBe(3);
  });
});
