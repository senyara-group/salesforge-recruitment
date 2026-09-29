// Lot 5 — contact humain (contact@swipsales.fr) dans les espaces candidat et recruteur.
// Validation statique du HTML/CSS (rendu réel vérifié séparément, voir rapport).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.resolve(__dirname, '../../frontend');
const ADDRESS = 'contact@swipsales.fr';
const SPACES = [
  { name: 'candidat', file: '_spaces/candidat.html', page: 'p-account' },
  { name: 'recruteur', file: '_spaces/recruteur.html', page: 'p-settings' },
];
const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8');

function pageBlock(html, id) {
  const start = html.indexOf(`<div id="${id}" class="page">`);
  assert.ok(start >= 0, id);
  const end = html.indexOf('<!-- ', start + 10);
  return html.slice(start, end);
}
function supportSection(html) {
  const match = html.match(/<section class="account-section support-contact" aria-labelledby="support-contact-title">[\s\S]*?<\/section>/);
  assert.ok(match, 'section support');
  return match[0];
}

for (const space of SPACES) {
  test(`${space.name} : contact humain dans la page Compte, adresse exacte, lien accessible`, () => {
    const html = read(space.file);
    const section = supportSection(html);
    assert.ok(pageBlock(html, space.page).includes(section), `section dans #${space.page}`);
    assert.match(section, /<h2 class="sf" id="support-contact-title">Besoin d'aide \? Parlez avec notre équipe<\/h2>/);
    const links = [...section.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)];
    assert.equal(links.length, 1);
    const [, attrs, text] = links[0];
    assert.match(attrs, new RegExp(`href="mailto:${ADDRESS.replace('.', '\\.')}"`));
    assert.equal(text, `Écrire à ${ADDRESS}`); // libellé explicite, adresse visible
    assert.doesNotMatch(attrs, /tabindex="-1"|aria-hidden|onclick/); // lien natif, focusable au clavier
    assert.match(attrs, /class="btn bo support-contact-link"/);
  });

  test(`${space.name} : mailto sans donnée utilisateur ni paramètre, adresse non dupliquée`, () => {
    const html = read(space.file);
    // Exactement deux occurrences : href + texte du lien, dans la seule section support.
    assert.equal(html.split(ADDRESS).length - 1, 2);
    assert.equal(supportSection(html).split(ADDRESS).length - 1, 2);
    assert.doesNotMatch(html, new RegExp(`mailto:${ADDRESS.replace('.', '\\.')}\\?`)); // ni subject, ni body
    assert.doesNotMatch(html, /['"`]mailto:contact@swipsales\.fr['"`]\s*\+/); // pas de mailto construit en JS
  });

  test(`${space.name} : wording humain et sobre, sans promesse de chat, de 24/7 ni de délai`, () => {
    const section = supportSection(read(space.file));
    assert.match(section, /une personne de l'équipe SwipSales lit votre message et vous répond par e-mail/);
    assert.doesNotMatch(section, /chat|en direct|temps réel|24\s*\/\s*7|24h|immédiat|sous \d+\s*(h|heures|jours)/i);
  });

  test(`${space.name} : mobile (statique) — zone tactile ≥ 44 px, retour à la ligne, focus visible`, () => {
    const html = read(space.file);
    const rule = html.match(/\.support-contact-link\{([^}]*)\}/);
    assert.ok(rule);
    assert.match(rule[1], /min-height:44px/);
    assert.match(rule[1], /max-width:100%/);
    assert.match(rule[1], /overflow-wrap:anywhere/);
    assert.match(html, /\.support-contact-link:focus-visible\{outline:2px solid var\(--b\)/);
  });
}

test('adresse centralisée : uniquement dans les deux sections support des espaces', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(html|js|css)$/.test(name)) files.push(full);
    }
  };
  walk(FRONTEND);
  const withAddress = files.filter((file) => fs.readFileSync(file, 'utf8').includes(ADDRESS)).map((file) => path.relative(FRONTEND, file).replace(/\\/g, '/'));
  assert.deepEqual(withAddress.sort(), SPACES.map((space) => space.file).sort());
});
