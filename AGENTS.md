# AGENTS.md — SwipSales

Guide pour toute personne ou tout agent (Claude, Codex…) qui modifie ce dépôt.
**À lire avant de toucher au style d'une page.** L'objectif : un seul design
system, et aucun composant recréé une deuxième fois.

## Le projet en bref

- `backend/` : API Express (Supabase, Stripe, Brevo). Sert aussi le dossier `frontend/`.
- `frontend/` : pages HTML sans framework, JavaScript intégré aux pages.
  - `swipsales_landing.html` : page marketing (**hors périmètre du design system** : elle garde son propre style).
  - Pages d'accès et pages publiques : `swipsales_start.html` (inscription), `swipsales_app.html` (connexion + coque qui charge l'espace dans une iframe), `swipsales_reset.html`, `certificat.html`, `swipsales_legal.html`.
  - `_spaces/candidat.html` et `_spaces/recruteur.html` : les deux applications. Chaque vue est un `<div id="p-…" class="page">`, affichée par `go('…')` qui ajoute `.on`.
- Lancer en local : voir `README.md` (`cd backend && npm run dev`, puis http://localhost:3000).

## Design system

Emplacement : `frontend/design-system/`

| Fichier | Contenu | Règle |
|---|---|---|
| `tokens.css` | Couleurs, typo, rayons, ombres, espacements, dimensions de la coque | **Seul endroit** où une valeur visuelle est écrite en dur |
| `components.css` | Composants génériques : coque, boutons, puces, formulaires, cartes, KPI, listes, onglets, états, superpositions, options, barres de score | Réutilisables partout |
| `features.css` | Blocs métier : accueil, pile de swipe, match, filtres, outils, ADN, test ADN, CV, coach, messagerie, profil, formules, espace recruteur, contraintes validées sur appareil réel | Uniquement ce qui n'entre pas dans un composant générique |
| `access.css` | Pages d'accès et publiques : connexion, inscription, réinitialisation, mentions légales, certificat | **Jamais** chargé dans les espaces (`.card`, `.brand`, `.msg` y ont un autre sens) |

Ces feuilles sont **les seules** feuilles de style des pages (hors landing). Ordre de chargement, toujours le même :

```html
<!-- Espaces candidat et recruteur (_spaces/) -->
<link rel="stylesheet" href="../design-system/tokens.css">
<link rel="stylesheet" href="../design-system/components.css">
<link rel="stylesheet" href="../design-system/features.css">

<!-- Pages d'accès et publiques (frontend/) -->
<link rel="stylesheet" href="design-system/tokens.css">
<link rel="stylesheet" href="design-system/components.css">
<link rel="stylesheet" href="design-system/access.css">
```

Polices chargées par toutes ces pages : Sora (600–800) et Inter (400–700), via Google Fonts.

Maquettes de référence (toutes les vues candidat, restylées sans rien ajouter ni retirer) :
https://claude.ai/artifact/J53SnsENRiULXqDyzZr1y2

La maquette fait foi pour l’apparence. Sa feuille (`project/swip.css`) porte les mêmes classes que le site : pour vérifier un écart, l’appliquer au vrai site et comparer le rendu élément par élément. Seule exception assumée : les éléments que la maquette omettait (icônes des cartes d’accueil, des outils, des documents du profil et de la zone de dépôt du CV, cœur de l’écran Match) restent affichés.

### Principes visuels (piste « Clarté »)

- Surfaces blanches sur fond `--bg`, bordures fines `--bd`, ombres très légères.
- Un seul bleu d'action : `--b` (#1340E0). Ne jamais réintroduire #2647E8, #1646D8 ou #1449D8.
- Deux polices : **Sora** (`.sf`, titres et chiffres) et **Inter** (tout le reste).
- Couleurs sémantiques par paires fond / texte : `--gs`/`--gt` succès, `--as`/`--at` attente, `--rs`/`--rt` erreur, `--pus`/`--put` ADN et premium, `--bs`/`--b2` information.
- Rayons : `--rad-s` (8) champs et petits boutons, `--rad` (10) boutons, `--rad-l` (14) cartes, `--rad-xl` (16) cartes de swipe et feuilles.
- Le swipe est le cœur du produit : la pile `.swipe-card` et les boutons `.db-*` restent les éléments les plus visibles des écrans Opportunités et Sourcing.
- Cible tactile : `--tap` (44 px) pour `.btn`, `.page-back-btn`, les lignes de suggestions, le sélecteur du pipeline. Largeur maximale du contenu d'une page : `--content-max` (1360 px).
- Pipeline recruteur : chaque étape a sa couleur `--stage` (posée par `[data-stage]`), déclinée en fond (`--stage-soft`) et bordure (`--stage-line`) avec `color-mix`.

## Règles d'or

1. **Chercher avant de créer.** Avant d'écrire une règle CSS, chercher dans le catalogue ci-dessous et dans `components.css` / `features.css`. Si un composant existe, l'utiliser tel quel.
2. **Aucune valeur en dur.** Couleurs, tailles de police, rayons, ombres, espacements : uniquement `var(--…)`. Si une valeur manque, l'ajouter dans `tokens.css` (avec un commentaire), jamais dans une page.
3. **Le style ne change pas le HTML.** On garde les éléments, l'ordre, les textes, les `id` et les classes existantes : le JavaScript s'en sert. Un restyle n'ajoute ni ne retire d'élément.
4. **Pas de nouveau CSS dans les pages.** Interdit d'ajouter des règles dans un `<style>` de page, un attribut `style="…"` (sauf valeurs dynamiques posées par le JS, comme une largeur de barre en %), ou une nouvelle feuille à côté.
5. **Pas de `!important`**, sauf les deux règles de comportement existantes : `[hidden]` (`components.css`) et `.chat-placeholder.hidden` (`features.css`).
6. **Pas de nouvelle variante pour un besoin existant.** Un bouton est `.btn` + `.bp` / `.bo` / `.bg` / `.bdanger` (+ `.bsm`, `.blk`). Une puce est `.chip` + couleur. Une carte est `.card-sec` ou `.account-section`.
7. **Nommer un nouveau composant** : nom court en anglais ou en abrégé, cohérent avec l'existant (`.xxx`, `.xxx-hd`, `.xxx-t`, `.xxx-body`), état par classe d'état (`.on`, `.sel`, `.is-active`, `.is-done`). L'ajouter dans le bon fichier **et** dans le catalogue ci-dessous, dans le même commit.
8. **Responsive par media query**, mobile d'abord. Paliers : `720px` (tablette) et `1024px` (barre latérale). Pas de classe « mobile » ajoutée au HTML.
9. **Accessibilité** : contraste AA (utiliser `--ink3` au minimum pour du texte, jamais plus clair), cibles tactiles ≥ 44 px, `:focus-visible` conservé, `prefers-reduced-motion` respecté.

## Catalogue des composants

### Coque (`components.css`)

| Classe | Rôle |
|---|---|
| `.app` | Conteneur racine d'un espace |
| `.topbar`, `.logo`, `.logo-m`, `.logo-n`, `.topbar-greet`, `.top-r` | Barre du haut |
| `.ib` (+ `.nd` pastille) | Bouton icône de la barre du haut |
| `.notif-panel(.on)`, `.notif-item(.unread)`, `.notif-ico`, `.notif-b`, `.notif-t`, `.notif-s`, `.notif-time`, `.notif-empty` | Panneau de notifications |
| `.bnav`, `.bn(.on)`, `.bn-secondary`, `.bn-ico-wrap`, `.nav-dot`, `.bnav-spacer`, `.bnav-credits`, `.usage-meter`, `.credits-bar(-fill)` | Navigation : barre basse en mobile, barre latérale dès 1024 px. `.bn-secondary` n'apparaît qu'en barre latérale |
| `.page(.on)` | Une vue. Colonne flex avec espacement automatique |

### En-têtes et sections

```html
<div class="page-heading">
  <div><div class="page-kicker">Suivi</div><h1 class="page-title sf">Titre</h1><p class="page-intro">Phrase d'intro.</p></div>
  <!-- actions éventuelles -->
</div>
<div class="sec"><div class="sec-hd"><div class="sec-t sf">Section</div><button class="btn bg bsm">Tout voir</button></div>…</div>
```

Aussi : `.page-heading-inline`, `.page-heading-title-row` + `.page-back-btn`, `.page-meta`, `.section-divider`.

### Boutons

```html
<button class="btn bp">Action principale</button>
<button class="btn bo">Action secondaire</button>
<button class="btn bg bsm">Lien d'action</button>
<button class="btn bdanger bsm">Supprimer</button>
<button class="btn bp blk">Pleine largeur</button>
```

Lien destructif dans une liste : `.link-danger`. Lien d'action discret dans un formulaire : `.link-action`. Bouton icône : `.ib`. Boutons du swipe : `.db.db-pass`, `.db.db-like`, `.db.db-super`. Bouton dont le libellé est long (adresse e-mail) : ajouter le modificateur `.support-contact-link` à `.btn bo` (retour à la ligne, 44 px minimum).

**Variantes historiques supprimées** (déjà remplacées dans toutes les pages, ne pas les réintroduire) :

| Ancien | Remplacé par |
|---|---|
| `save-btn` | `btn bp save-btn` (`save-btn` reste : le JS s'en sert comme repère) |
| `po-primary` | `btn bp` |
| `upload-btn`, `po-secondary`, `res-secondary` | `btn bo` |
| `po-danger`, `cv-delete` | `btn bdanger` |
| `btn-copy` | `btn bo bsm` |
| `bg2` | `btn bg` |
| `btn` seul (pages d'accès), `social`, `cta` | `btn bp blk`, `btn bo blk social`, `btn bp` |
| `b-bleu`, `b-encre`, `b-blanc`, `b-line` | réservés à la landing, ne pas utiliser ailleurs |

### Puces, statuts, filtres

```html
<span class="chip chip-g"><span class="chip-dot"></span>Actif</span>
```

Couleurs : `.chip-b` (info), `.chip-g` (succès), `.chip-a` (attente), `.chip-pu` (entretien, ADN), `.chip-r` (refus). Correspondance des statuts de candidature : voir `cChip()` dans `candidat.html`.
Aussi : `.feature-status` (petit libellé bleu), `.filter-row` + `.fp(.on)` + `.fp-count` (filtres rapides), `.form-chips` + `.form-chip(.on)` (choix multiples dans un formulaire), `.tab-seg` + `.tsb(.on)` (onglets), `.bill-toggle` + `.bill-opt(.on)` + `.bill-save` (mensuel / annuel).

### Formulaires

`.form-label` (libellé englobant ; avec une case à cocher, s'affiche en ligne), `.form-input`, `.form-textarea`, `.form-select`, `.form-field`, `.form-feedback(.is-error)` (message sous un formulaire, caché quand vide), `small` (mention « facultatif »), `.form-grid` > `.field` (grille de champs), `.err(.on)` (bandeau d'erreur), `.autocomplete-list(.on/.is-inline)` > `.autocomplete-item` + `.autocomplete-status` (saisie avec suggestions de communes).
Recruteur : `.form-group` (champ du formulaire de publication), `.form-hint-err`, `.form-toggle` + `.form-toggle-copy`.

### Divers

`.toast(.on)` (notification éphémère), `.card` + `.card-footer` (conteneur blanc simple), `.sr-only`.

### Cartes et contenus

| Classe | Rôle |
|---|---|
| `.card-sec` > `.card-sec-hd` > `.card-sec-t` | Carte de contenu générique |
| `.account-section` (`.is-upsell` pour une porte d'accès payante) + `.account-value` | Bloc de réglage, consentement, accès réservé |
| `.kpi-grid` > `.kpi` > `.kpi-l` / `.kpi-v` / `.kpi-t(.tu/.tf)` | Indicateurs (2 colonnes en mobile, 4 dès 720 px). Cliquable : `.kpi-link` ou `button.kpi`. Avec icône : `.kpi-card` + `.kpi-ico`, dont la couleur suit `.kpi-tone-blue/-green/-amber/-purple/-slate` (pas de liseré, comme la maquette) |
| `.tr-list` > `.tr-item` > `.tr-logo`, `.tr-info` (`.tr-title`, `.tr-sub`), `.candidate-status-actions`, `.candidate-date` | Liste de suivi (candidatures, offres…) |
| `.menu-list` > `.menu-i` > `.menu-ico`, `.menu-txt` | Liste de raccourcis |
| `.opts` > `.opt(.sel)` > `.ob(-f/-c/-h/-a)`, `.ot`, `.oh` + `.step-nav` | Choix d'une option (tests, questionnaires) |
| `.adn-row` > `.adn-l`, `.adn-tr` > `.adn-f`, `.adn-s` | Barre de score |
| `.test-pb` > `.test-pf` | Barre de progression |
| `.ai-availability(.on)`, `.cv-quota-chip`/`.coach-quota-chip` (`.is-low`, `.is-empty`), `.cv-toolbar` | État d'un service IA et quota |

### États

`.loading-state` (+ `.spinner`), `#p-auth` + `.auth-logo` (écran « Session introuvable » des deux espaces), `.empty-state` (`<b>` titre + `<span>` texte + bouton), `.deck-empty` (pile de swipe vide).

### Superpositions

```html
<div class="overlay on"><div class="bottom-sheet"><div class="sh-handle"></div>…<div class="sh-actions">…</div></div></div>
```

Feuille ancrée en bas sur mobile, boîte centrée dès 720 px. Variante large : `.bottom-sheet.filters-sheet`.

### Blocs métier (`features.css`)

| Fonctionnalité | Classes racines |
|---|---|
| Accueil candidat | `.home-hero`, `.priority-tools` > `.priority-card`, `.photo-nudge`, `.next-action`, `.score-card` |
| Pile de swipe | `.swipe-hd`, `.deck-wrap`, `.deck-area`, `#deck-cards`, `.swipe-card` (`.sw-lbl`, `.card-identity`, `.card-body`…), `.deck-actions` > `.db` |
| Match | `.match-hd`, `.match-icons` > `.mco` + `.mlink`, `.match-stats` > `.mstat`, `.prep-box` |
| Filtres | `.filt-section`, `.filt-label`, `.filt-help`, `.filt-check`, `.filt-actions` |
| Outils et bibliothèque | `.coaching-tools` > `.tool-row`, `.library-intro`, `.resource-*`, `.doc-list` > `.doc-item` |
| ADN approfondi | `.deep-adn-state`, `.deep-adn-intro/-question/-result`, `.deep-adn-progress` |
| Test ADN | `.test-sticky`, `.test-body`, `.qt`, `.qh`, `.sc-box`, `.slg` > `.sl-row`, `.mcqg` > `.mcq`, `.pitch-box`, `.ta-block`, `.prefs-sec` > `.pc`, `.analyzing`, `.res-*` |
| Optimiseur de CV | `.cv-journey`, `.cv-panel`, `.cv-dropzone`, `.cv-waiting`, `.ai-results` > `.cv-result-card`, `.improved-cv-card` |
| Coach | `.coach-shell` > `.coach-history` + `.coach-main` (`.coach-setup`, `.coach-conversation`, `.coach-message`) |
| Messagerie | `.messages-workspace` > `.conversations-panel` (`.msg-th`) + `.conversation-panel` (`.chat-*`, `.bubble`) |
| Profil | `.profile-hero` (`.ph-*`), `.profile-edit-panel`, `.profile-layout`, `.comp-*`, `.prefs-block` |
| Formules | `.pricing-hd`, `.plans-row` > `.plan-card(.pop/.dk/.active-plan)` > `.pc-*` |

### Espace recruteur (`features.css`)

Il réutilise la coque, les boutons, puces, KPI, listes, messagerie, formules et la pile de swipe. Blocs propres :

| Écran | Classes racines |
|---|---|
| Coque | `.logo-tag` (mention « Recruteur ») |
| Activité | `.dash-shell`, `.dash-hero-card` (`.dash-hero-main`, `.dash-hello`, `.dash-co` > `.dash-co-logo(.is-empty)`, `.dash-hero-aside` > `.dash-aside-*`), `.dash-mid` / `.dash-bottom` > `.dash-panel`, `.dash-action-list` > `.dash-action-item(.is-primary)`, `.dash-stages` > `.dash-stage` + `.dash-stage-bar`, `.dash-recent-offer` (`.dash-ro-*`), `.dash-summary-note` |
| Candidatures reçues | `#cands-recues` > `.cand-recue` > `.cr-av`, `.cr-info` (`.cr-name`, `.cr-badge`, `.cr-title`, `.cr-meta` > `.cr-tag`), `.cr-score` |
| Carte candidat (sourcing) | `.cand-top.cand-identity(.anon)` > `.cand-identity-inner` (`.cand-match-box`, `.cand-co-block` > `.cand-avatar`, `.cand-name`, `.cand-role`, `.cand-identity-facts` > `.cand-fact`), `.cand-body` (`.cand-body-hd`, `.cand-match-inline`, `.cand-rank`, `.cand-skills`, `.cand-docs`, `.cand-mid` > `.cand-adn-section` + `.cadn-row` / `.cand-pitch`, `.cand-letter` + `.clt` + `.clm-*`, `.cand-predict`) |
| Filtres du sourcing | `.cand-filter-bar`, `.comp-filter-badge`, `.cand-filter-summary` > `.cand-filter-chip`, `.cand-filter-meta` |
| Fiche candidat (feuille) | `.cov-tags`, `.cov-plan-note`, `.cov-full-profile`, `.candidate-workflow` |
| Offres | `.offers-list` > `.offer-card` (`.offer-card-hd`, `.offer-title`, `.offer-status(.paused)`, `.offer-meta`, `.offer-tags` > `.offer-tag`, `.offer-actions`) |
| Pipeline | `.pipeline-offers` > `.po-card` (`.po-*`), `.pipe-cols(.is-dragging-board)` > `.pipe-col[data-stage](.is-target/.can-drop/.no-drop)` > `.pipe-col-hd` + `.pipe-col-body` > `.pipe-card(.is-dragging/.is-ghost)` (`.pipe-open`, `.pipe-card-top`, `.pc-*`, `.pipe-move`), `.pipe-state(.error)`, `.pipe-flow`, `.pipeline-end` |
| Moteur de matching | `.match-intro`, `.match-engine` > `.me-hd` + `.me-row` (`.me-l`, `.me-v`, `.me-inp`) ; questions : `.q-item(.on)` > `.q-check`, `.q-text`, `.q-cat` |

### Pages d'accès et publiques (`access.css`)

| Page | Classes |
|---|---|
| Mise en page | carte centrée `.card` / `.role-choice(.on)`, `.brand` > `.mark` + `.logo` |
| Formulaires | `.field`, `.or`, `.socials` > `.btn.bo.blk.social` (+ `.icon-badge`), `.secondary`, `.forgot-btn`, `.back`, `.msg(.error/.success/.ok)` |
| Connexion | `.boot` (`.boot-title`, `.boot-text`, `.boot-spin`), `.role-grid` > `.role-btn`, `#app-frame` (iframe de l'espace) |
| Inscription | `.role` > `button(.on)`, `.recruiter-fields(.on)`, `body.recruteur-theme`, `.confirm-mail(.on)` > `.confirm-ico` |
| Réinitialisation | `.state(.on)` > `.state-ico(.ok/.err)` |
| Mentions légales | `body > nav`, `body > header` (`.head-inner`, `.eyebrow`, `.intro`, `.tabs` > `.tab`), `.doc` (`.doc-k`, `.meta`, `.notice`, `.table` > `.row(.head)`) |
| Certificat | `.badge`, `.eyebrow`, `.score`, `p.err` |

## État de la migration

Toutes les pages (hors landing) utilisent uniquement le design system : plus aucun `<style>` dans les pages. Les anciennes feuilles (`app-professional.css`, `messages-mobile.css`, `recruiter-dashboard.css`, `recruiter-desktop.css`, `recruiter-mobile.css`, `recruiter-pipeline.css`) ont été supprimées. Seuls le style et les noms de classes ont changé : éléments, textes, `id` et JavaScript sont identiques.

Pour vérifier une modification en local : `cd backend && npm run dev`, puis chaque vue en mobile (390 px) et en bureau (1280 px), y compris les états (vide, chargement, erreur) et les superpositions.

## Contraintes verrouillées par les tests

Certaines règles ont été mesurées sur appareil réel et sont protégées par `backend/test` (`npm test`). Les tests lisent le design system via `backend/test/helpers/designSystemCss.js`. Ne les contourner jamais : corriger le CSS, ou faire évoluer le test **et** la règle ensemble.

- Barre basse fixe, sans `transform` ni centrage par marge ; barre latérale ancrée à gauche (`mobileLayoutStability`).
- Iframe de l'espace (`#app-frame`) fixe à 100 %, jamais en unités `vh` (`mobileLayoutStability`).
- Coach : grilles `minmax(0, 1fr)`, enfants `min-width: 0`, bulles en `pre-wrap` + `overflow-wrap: anywhere`, hauteur mobile en `svh` (section « Contraintes validées sur appareil réel » de `features.css`).
- Cibles de 44 px : `.page-back-btn`, `.autocomplete-item`, `.pipe-move` (sauf souris), `.btn.support-contact-link`, champs `.filters-sheet .form-field`.
- Formules : la carte active garde une bordure `--g`, la carte populaire `--b`, contraste ≥ 4,5 (`subscriptionPlansConsistency`).
- Pipeline : sélecteurs limités aux classes `pipe-*`, `pc-*`, `po-*`, `pipeline-*`, `candidate-workflow` et `[data-stage]` (`recruiterKanbanV2`).

## Avant de valider une modification de style

- [ ] Aucune valeur en dur ajoutée hors de `tokens.css`.
- [ ] Aucun nouveau composant qui duplique un composant du catalogue.
- [ ] Aucun élément HTML ajouté ou retiré, aucun `id` ni texte modifié pour des raisons de style.
- [ ] Pas de `!important`, pas de `<style>` ni de `style="…"` ajoutés dans une page.
- [ ] Nouveau composant ou nouvelle classe : ajouté au catalogue de ce fichier.
- [ ] Rendu vérifié en mobile et en bureau.
- [ ] `cd backend && npm test` passe.
