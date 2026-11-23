// Lecture du design system (frontend/design-system/) pour les tests statiques de style.
// Le CSS est compacté (sans commentaires ni espaces autour de « { } : ; , > ») afin
// que les assertions restent lisibles : /position:fixed/ par exemple.
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.resolve(__dirname, '../../../frontend/design-system');

function compact(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\s*([{}:;,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .replace(/\s+/g, ' ')
    .trim();
}

function read(name) {
  return compact(fs.readFileSync(path.join(DIR, `${name}.css`), 'utf8'));
}

// Feuilles chargées par les espaces candidat et recruteur, dans l'ordre.
function spaceCss() {
  return ['tokens', 'components', 'features'].map(read).join('\n');
}

// Découpe un bloc CSS compacté en règles de premier niveau : { prelude, body }.
function blocks(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth) { if (css[j] === '{') depth += 1; else if (css[j] === '}') depth -= 1; j += 1; }
    out.push({ prelude: css.slice(i, open).trim(), body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

// Contenu (concaténé) des blocs @media dont la requête compactée vaut `query`,
// ex. '(min-width:1024px)'. Sans requête : règles hors @media.
function media(css, query) {
  return blocks(css).filter((b) => (query ? b.prelude === `@media ${query}` : !b.prelude.startsWith('@')))
    .map((b) => (query ? b.body : `${b.prelude}{${b.body}}`)).join('');
}

// Déclarations effectives (la dernière l'emporte) des règles dont le sélecteur est
// exactement `selector`, au niveau du bloc donné. Renvoie « prop:valeur;… » ou null.
function rule(css, selector) {
  const wanted = compact(selector);
  const decls = new Map();
  for (const b of blocks(css)) {
    if (b.prelude !== wanted) continue;
    for (const decl of b.body.split(';')) {
      const k = decl.indexOf(':');
      if (k > 0) decls.set(decl.slice(0, k), decl.slice(k + 1));
    }
  }
  return decls.size ? [...decls].map(([p, v]) => `${p}:${v}`).join(';') : null;
}

module.exports = { DIR, compact, read, spaceCss, blocks, media, rule };
