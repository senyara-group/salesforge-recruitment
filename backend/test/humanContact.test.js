// Lot 5 — contact humain et adresse publique officielle contact@swipsales.fr
// (espaces candidat/recruteur, landing, mentions légales / CGV / confidentialité).
// Validation statique du HTML/CSS ; les mailto sont analysés avec le parseur URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const FRONTEND = path.join(ROOT, 'frontend');
const ADDRESS = 'contact@swipsales.fr';
const PERSONAL = 'senechalyannis@gmail.com';
const HELP_SUBJECT = "SwipSales — Demande d'aide";
const SPACES = [
  { name: 'candidat', file: '_spaces/candidat.html', page: 'p-account' },
  { name: 'recruteur', file: '_spaces/recruteur.html', page: 'p-settings' },
];
const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8');

function pageBlock(html, id) {
  const start = html.indexOf(`<div id="${id}" class="page">`);
  assert.ok(start >= 0, id);
  return html.slice(start, html.indexOf('<!-- ', start + 10));
}
function supportSection(html) {
  const match = html.match(/<section class="account-section support-contact" aria-labelledby="support-contact-title">[\s\S]*?<\/section>/);
  assert.ok(match, 'section support');
  return match[0];
}
/** Analyse un mailto : destinataire unique, paramètres et valeurs décodées. */
function parseMailto(href) {
  const url = new URL(href);
  assert.equal(url.protocol, 'mailto:');
  return { to: decodeURIComponent(url.pathname), params: Object.fromEntries(url.searchParams) };
}
function frontendFiles() {
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(html|js|css)$/.test(name)) files.push(full);
    }
  };
  walk(FRONTEND);
  return files;
}
const rel = (file) => path.relative(FRONTEND, file).replace(/\\/g, '/');

for (const space of SPACES) {
  test(`A/B/H. ${space.name} : contact humain dans la page Compte, lien natif accessible`, () => {
    const html = read(space.file);
    const section = supportSection(html);
    assert.ok(pageBlock(html, space.page).includes(section), `section dans #${space.page}`);
    assert.match(section, /<h2 class="sf" id="support-contact-title">Besoin d'aide \? Parlez avec notre équipe<\/h2>/);
    const links = [...section.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)];
    assert.equal(links.length, 1);
    const [, attrs, text] = links[0];
    assert.equal(text, `Écrire à ${ADDRESS}`); // libellé explicite, adresse visible, pas d'icône seule
    assert.doesNotMatch(attrs, /tabindex="-1"|aria-hidden|onclick|role=/); // <a href> natif : clavier OK
    assert.match(attrs, /class="btn bo support-contact-link"/);
  });

  test(`F/G. ${space.name} : mailto valide, sujet d'aide encodé, aucune donnée utilisateur`, () => {
    const section = supportSection(read(space.file));
    const href = section.match(/href="([^"]+)"/)[1];
    assert.equal(href, 'mailto:contact@swipsales.fr?subject=SwipSales%20%E2%80%94%20Demande%20d%27aide');
    const { to, params } = parseMailto(href);
    assert.equal(to, ADDRESS);
    assert.deepEqual(params, { subject: HELP_SUBJECT }); // ni body, ni cc, ni donnée utilisateur
    assert.doesNotMatch(href, /\$\{|%24%7B|@.*@/); // pas de gabarit JS, un seul destinataire
  });

  test(`${space.name} : wording humain et sobre, sans promesse de chat, de 24/7 ni de délai`, () => {
    const section = supportSection(read(space.file));
    assert.match(section, /une personne de l'équipe SwipSales lit votre message et vous répond par e-mail/);
    assert.doesNotMatch(section, /chat|en direct|temps réel|24\s*\/\s*7|24h|immédiat|sous \d+\s*(h|heures|jours)/i);
  });

  test(`I. ${space.name} : mobile (statique) — zone tactile ≥ 44 px, retour à la ligne, focus visible`, () => {
    const html = read(space.file);
    const rule = html.match(/\.support-contact-link\{([^}]*)\}/);
    assert.ok(rule);
    assert.match(rule[1], /min-height:44px/);
    assert.match(rule[1], /max-width:100%/);
    assert.match(rule[1], /overflow-wrap:anywhere/);
    assert.match(html, /\.support-contact-link:focus-visible\{outline:2px solid var\(--b\)/);
  });
}

test('recruteur : palier Partenaire (sur devis) → adresse officielle, sujet fixe, aucune donnée utilisateur', () => {
  const html = read('_spaces/recruteur.html');
  const fn = html.match(/function contactPartenaire\(\) \{([\s\S]*?)\n\}/)[1];
  assert.match(fn, /'mailto:contact@swipsales\.fr\?subject=' \+ encodeURIComponent\('SwipSales — palier Partenaire \(sur devis\)'\)/);
  assert.doesNotMatch(fn, /USER|PROFILE|email|token|\$\{/i);
});

test('C/H. landing : pied de page « Contact » vers l’adresse officielle, adresse visible', () => {
  const html = read('swipsales_landing.html');
  const footer = html.match(/<div class="foot-l">([\s\S]*?)<\/div>/)[1];
  const link = footer.match(/<a href="(mailto:[^"]+)">([^<]*)<\/a>/);
  assert.ok(link, 'lien de contact dans le footer');
  assert.deepEqual(parseMailto(link[1]), { to: ADDRESS, params: {} });
  assert.equal(link[2], `Contact : ${ADDRESS}`);
  // Zone tactile ≥ 44 px et focus visible sur les liens du pied de page (fond sombre).
  assert.match(html, /\.foot-l a\{display:inline-flex;align-items:center;min-height:44px\}/);
  assert.match(html, /\.foot-l a:focus-visible\{outline:2px solid #fff/);
  // Bloc Partenaire (commenté, palier masqué) aligné pour une réactivation future.
  assert.match(html, /mailto:contact@swipsales\.fr\?subject=SwipSales%20%E2%80%94%20palier%20Partenaire/);
});

test('D. mentions légales, CGV et confidentialité : contact éditeur / vendeur / service client / RGPD', () => {
  const html = read('swipsales_legal.html');
  const section = (id) => html.slice(html.indexOf(`id="${id}"`), html.indexOf('</section>', html.indexOf(`id="${id}"`)));
  assert.match(section('cgu'), /Email de contact : contact@swipsales\.fr\./);
  assert.match(section('cgv'), /Email : contact@swipsales\.fr\./);
  assert.match(section('cgv'), /contacter le service client à l'adresse : contact@swipsales\.fr\./);
  assert.match(section('rgpd'), /Contact pour les données personnelles : contact@swipsales\.fr\./);
  assert.match(section('rgpd'), /adresser sa demande à : contact@swipsales\.fr\. Une réponse sera apportée dans les délais légaux/);
  assert.equal(html.split(ADDRESS).length - 1, 5);
  // Aucune autre information légale modifiée : identité, adresse postale et CNIL toujours présentes.
  assert.match(html, /Yannis Sénéchal, entrepreneur individuel/);
  assert.match(html, /4 rue des Saules, 59230 Saint-Amand-les-Eaux/);
  assert.match(html, /www\.cnil\.fr/);
});

test('E. aucun Gmail personnel dans le produit ; une seule adresse publique cohérente', () => {
  const files = frontendFiles();
  assert.deepEqual(files.filter((file) => fs.readFileSync(file, 'utf8').includes(PERSONAL)).map(rel), []);
  const withAddress = files.filter((file) => fs.readFileSync(file, 'utf8').includes(ADDRESS)).map(rel).sort();
  assert.deepEqual(withAddress, ['_spaces/candidat.html', '_spaces/recruteur.html', 'swipsales_landing.html', 'swipsales_legal.html']);
  // Tous les mailto du produit visent l'adresse officielle et ne portent au plus qu'un sujet.
  for (const file of files) {
    for (const [, href] of fs.readFileSync(file, 'utf8').matchAll(/href="(mailto:[^"]+)"/g)) {
      const { to, params } = parseMailto(href);
      assert.equal(to, ADDRESS, `${rel(file)} : ${href}`);
      assert.deepEqual(Object.keys(params).filter((key) => key !== 'subject'), [], rel(file));
    }
  }
  // Documentation : seule l'entrée historique datée mentionne encore l'ancienne adresse.
  const notes = fs.readFileSync(path.join(ROOT, 'Notes.md'), 'utf8');
  const lines = notes.split(/\r?\n/).filter((line) => line.includes(PERSONAL));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /remplacé le 2026-09-29 par `contact@swipsales\.fr`/);
});
