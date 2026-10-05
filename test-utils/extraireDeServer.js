// Extrait une fonction de `server.js` et l'evalue avec des doublures.
//
// Pourquoi : server.js fait ~38 000 lignes et n'est pas importable — l'importer demarre un
// serveur HTTP et ouvre une connexion a la base. Recopier les fonctions dans le test donnerait
// un test qui valide une COPIE : il resterait vert pendant que le code livre derive.
// On decoupe donc la source reelle, a chaque execution.
//
// Hors de `__tests__/` a dessein : jest y traite tout fichier comme une suite, et un module
// d'outillage sans `test()` ferait echouer la commande.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CHEMIN = path.join(__dirname, '..', 'server.js');

// Decoupe `async function nom(...) { ... }` jusqu'a l'accolade fermante de COLONNE 0. Le fichier
// respecte cette mise en forme partout ; une fonction imbriquee ne serait pas trouvee ainsi.
function source(nom) {
  const texte = fs.readFileSync(CHEMIN, 'utf8');
  const debut = texte.indexOf(`async function ${nom}(`);
  if (debut === -1) throw new Error(`${nom} introuvable dans server.js`);
  const fin = texte.indexOf('\n}', debut);
  if (fin === -1) throw new Error(`fin de ${nom} introuvable`);
  const bloc = texte.slice(debut, fin + 2);
  // Garde-fou : une extraction qui rendrait trois lignes ferait passer les tests pour la
  // mauvaise raison. Aucune de ces fonctions n'est courte.
  if (bloc.split('\n').length < 5) throw new Error(`extraction de ${nom} suspecte (${bloc.split('\n').length} lignes)`);
  return bloc;
}

// Monte une ou plusieurs fonctions dans un bac a sable, avec les doublures fournies.
function monter(noms, doublures = {}) {
  const bac = { console: { warn() {}, log() {}, error() {} }, ...doublures };
  vm.createContext(bac);
  vm.runInContext([].concat(noms).map(source).join('\n'), bac);
  return bac;
}

module.exports = { source, monter };
