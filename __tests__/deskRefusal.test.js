// Pourquoi Zoho Desk a refuse un billet — la distinction qui manquait le 2026-10-05.
//
// Ce jour-la, l'ecran disait « un admin doit reconnecter Desk » sur un acces parfaitement
// valide : les portees OAuth etaient toutes accordees, le jeton se rafraichissait (HTTP 200) et
// la lecture fonctionnait. Le vrai refus etait un 403 FORBIDDEN — le compte Desk epingle n'etait
// pas agent du departement choisi. Reconnecter n'y aurait rien change.
//
// Un message faux ne coute pas qu'un clic : il envoie chercher la panne au mauvais endroit.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// `deskRefusalKind` est synchrone : l'extracteur partage ne decoupe que les `async`.
function monter() {
  const debut = SOURCE.indexOf('function deskRefusalKind(status, brut) {');
  if (debut === -1) throw new Error('deskRefusalKind introuvable dans server.js');
  const fin = SOURCE.indexOf('\n}', debut);
  const bac = {};
  vm.createContext(bac);
  vm.runInContext(SOURCE.slice(debut, fin + 2), bac);
  return bac.deskRefusalKind;
}

const motif = monter();

describe('deskRefusalKind', () => {
  // Le cas reel, copie du journal d'activite de la production.
  test('LE cas du 2026-10-05 : 403 FORBIDDEN n’est PAS une histoire de reconnexion', () => {
    const reel = '{"errorCode":"FORBIDDEN","message":"You are not authorized to access this resource."}';
    expect(motif(403, reel)).toBe('desk_forbidden');
    expect(motif(403, reel)).not.toBe('desk_scope');
  });

  // Le cas du 2026-10-01, lui, demandait bien une reconnexion : corps VIDE, HTTP 401.
  test('401 au corps vide reste une affaire de jeton', () => {
    expect(motif(401, '{}')).toBe('desk_scope');
  });

  test('un corps qui nomme OAuth l’emporte sur le code HTTP', () => {
    // Desk renvoie parfois 403 pour une portee manquante : c'est alors bien le jeton.
    expect(motif(403, '{"errorCode":"INVALID_OAUTH"}')).toBe('desk_scope');
    expect(motif(403, '{"message":"invalid_token"}')).toBe('desk_scope');
    expect(motif(400, '{"error":"OAUTH_SCOPE_MISMATCH"}')).toBe('desk_scope');
  });

  test('le reste n’est ni l’un ni l’autre', () => {
    expect(motif(422, '{"errorCode":"INVALID_DATA","message":"departmentId is invalid"}')).toBe('desk_refused');
    expect(motif(500, '{}')).toBe('desk_refused');
    expect(motif(404, '{"errorCode":"URL_NOT_FOUND"}')).toBe('desk_refused');
  });

  test('un corps absent ou illisible ne fait pas planter la classification', () => {
    for (const v of [null, undefined, '', 0, {}]) {
      expect(['desk_scope', 'desk_forbidden', 'desk_refused']).toContain(motif(403, v));
      expect(['desk_scope', 'desk_forbidden', 'desk_refused']).toContain(motif(200, v));
    }
  });

  // TEMOIN NEGATIF — l'ancienne regle rangeait 401 ET 403 sous « reconnectez Desk ». On la
  // rejoue pour verifier que la nouvelle dit vraiment autre chose, au lieu de passer pour les
  // memes raisons.
  test('temoin : l’ancienne regle se trompait bien sur ce cas', () => {
    const reel = '{"errorCode":"FORBIDDEN","message":"You are not authorized to access this resource."}';
    const ancienne = (status, brut) =>
      (status === 401 || status === 403 || /scope|INVALID_OAUTH|UNAUTHORIZED/i.test(brut))
        ? 'desk_scope' : 'desk_refused';
    expect(ancienne(403, reel)).toBe('desk_scope');        // l'erreur d'hier
    expect(motif(403, reel)).toBe('desk_forbidden');       // corrigee
    // Et sur le cas qui demandait VRAIMENT une reconnexion, les deux sont d'accord.
    expect(ancienne(401, '{}')).toBe(motif(401, '{}'));
  });
});
