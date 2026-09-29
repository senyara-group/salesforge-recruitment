# Audit de cohérence des filtres + autocomplétion des communes (Lot 6)

Base : `origin/master` 7ed3c90. Aucune migration, aucune écriture de données, aucun
changement de scoring ni de matching. Voir aussi `LOCATION.md` (moteur du filtre lieu).

## 1. Matrice — Opportunités (espace candidat → `GET /offres/deck`)

| Filtre UI | Valeur UI | Donnée (écriture) | Requête | Absent / NULL | Statut |
|---|---|---|---|---|---|
| Contrat (`filt-contract`) | CDI, Alternance, Mission, Freelance | `offres.contract_type` (vocabulaire ; historique dérivé de `type`) | `in` | exclu si filtre actif | OK |
| Mode de travail (`filt-remote`) | onsite, hybrid, remote | `offres.remote_mode` | `in` | exclu | OK |
| Salaire min (`filt-salary-min`) | entier € | `salary_fixed_min/max` | `or` (max ≥ X, sinon min ≥ X) | **exclu par défaut ; nouvelle case « Inclure les offres sans salaire fixe »** | P2 corrigé |
| Tags (`filt-tags`) | 7 tags = `OFFER_TAG_VOCABULARY` | `offres.tags` | `overlaps` | exclu | OK |
| Métier (`filt-job-type`) | texte libre + suggestions | `job_type` canonicalisé ou brut | `imatch` ancré : libellé canonique → famille déclarée ; alias → libellé + cet alias | exclu | OK (Lot 4, Lot 7 : historique) |
| Secteur (`filt-sector`) | texte libre + suggestions | `sector` canonicalisé ou brut | `imatch` ancré sur la famille déclarée | exclu | **Lot 7** : alias `SaaS` → `SaaS et Tech` |
| Publication (`filt-published`) | 24h, 7d, 30d | `created_at` | `gte` | — | OK |
| Localisation (`filt-location`) | texte / commune suggérée | `offres.lieu` | `match` mot entier, accents/casse ignorés | exclu | OK + autocomplétion |

## 2. Matrice — Sourcing (espace recruteur → `GET /candidats/deck`)

| Filtre UI | Valeur UI | Donnée (écriture profil) | Requête | Absent / NULL | Statut |
|---|---|---|---|---|---|
| Score ADN min | 50, 70, 85 | `score_adn` | `gte` | exclu | OK |
| Métiers visés | 15 labels canoniques | `target_job_types` (canonicalisé, inconnu conservé) | post-filtre JS (scan borné) | exclu | **Lot 7** : alias historiques retrouvés |
| Style de vente | hunter, farmer, full | `sales_style` | `in` | exclu | OK |
| Expérience min | entier | `years_experience` | `gte` | exclu | OK |
| Contrats souhaités | CDI, Alternance, Freelance, Mission | `desired_contracts` | `overlaps` | exclu | OK |
| Secteurs | 10 secteurs canoniques | `sectors` | post-filtre JS (scan borné) | exclu | **Lot 7** : alias historiques retrouvés |
| Compétences | 6 compétences | `skills` (canonicalisées) | post-filtre JS canonique | exclu | OK |
| Outils / Méthodes | 6 / 6 | `tools` / `methodologies` | `overlaps` | exclu | OK |
| Disponibilité | immediate, 1_month, 3_months | `availability` | `in` | exclu | OK |
| Types de clients | PME, ETI, Grands comptes, Particuliers | `customer_types` | `overlaps` | exclu | OK |
| Localisation | texte / commune suggérée | `axes.meta.ville` | `match` + anonymes exclus + post-filtre JS | exclu | OK + autocomplétion |

Chaque valeur de chip est lue dans le HTML par `test/filterCoherence.test.js`, écrite par le
vrai chemin d'écriture, puis retrouvée via la vraie fonction de paramètres de la page et le
vrai handler (PostgREST simulé).

## 3. Priorités

- **P1** : aucun trouvé (aucun filtre visible sans chemin backend, aucune fuite, aucun 400 sur une valeur d'UI).
- **P2 corrigés** : autocomplétion des communes unifiée sur les 4 champs ; salaire : les offres sans fixe renseigné étaient exclues silencieusement → case explicite + aide.
- **P2 documentés (non corrigés, décision produit / données)** :
  - communes homonymes indiscernables : seul le nom est stocké (pas de code INSEE) ;
  - filtre candidat « métier » en texte libre (pas de liste).
- **P3** : filtres backend sans UI (`variable_share`, `sales_styles`, `customer_types`, `skills`, expérience côté offres) ; champs d'offre jamais renseignés par l'UI ; listes de chips dupliquées en dur (identiques aux constantes backend) ; `doRegister` mort (`r-ville` absent) ; la route d'auth accepte encore `ville`.

## 4. Champs de localisation

| Champ | Stockage | Autocomplétion | Saisie libre |
|---|---|---|---|
| Lieu d'offre `of-lieu` (création + édition) | `offres.lieu` | commune + « Remote / Télétravail », « France entière » | non : une suggestion doit être choisie (`LIEU_SELECTIONNE`, comportement inchangé) ; l'édition conserve la valeur historique |
| Ville du profil `edit-ville` | `candidats.axes.meta.ville` | commune | oui |
| Filtre Opportunités `filt-location` | paramètre `location` | commune (liste en flux) | oui |
| Filtre Sourcing `filt-cand-location` | paramètre `location` | commune (liste en flux) | oui |

## 5. Composant `frontend/commune-autocomplete.js`

- **API** : `geo.api.gouv.fr/communes?nom=…&fields=nom,codeDepartement&boost=population&limit=8`, déjà utilisée auparavant et sans nouvelle dépendance.
- **Requêtes** : aucune sous 2 caractères. Debounce de 250 ms, cache par requête. `AbortController` combiné à un numéro de séquence : une réponse obsolète est ignorée.
- **Suggestions** : libellé « Nom (département) » pour lever l'ambiguïté des homonymes. La valeur insérée est le nom seul, au même format que l'historique.
- **ARIA** : combobox/listbox, `aria-activedescendant`, `aria-expanded` et statut `aria-live`.
- **Interactions** : ↑/↓ (avec bouclage), Entrée, Échap et Tab ; `mousedown` sur une option ; un clic extérieur ferme la liste.
- **Erreurs** : message discret, jamais bloquant ; la saisie libre est conservée.
- **Sans le script** : les pages restent utilisables, avec une saisie libre pour tous les champs.
- **Messages par instance** (`statusMessages`) : le lieu d'offre, où la sélection est obligatoire, n'annonce jamais que le texte libre sera accepté (« Aucune commune trouvée. Choisissez une suggestion, ou utilisez Remote / Télétravail ou France entière. » / « Suggestions indisponibles. Réessayez dans un instant. »).
- **Fermeture** : Échap, Tab, clic extérieur ou sélection annulent la recherche en cours ; une réponse tardive n'ouvre jamais la liste d'un champ qui n'a plus le focus. Option `context` (overlay de filtres) : quand il perd la classe `on`, quel que soit le chemin de fermeture, l'instance est réinitialisée (aucune suggestion périmée à la réouverture). Le défilement de la liste repart du haut à chaque rendu.
- **Validation du correctif** : 16 tests ciblés passent, dont les scénarios A–L et le refus de Paris saisi après Lille sélectionnée en création comme en modification (PUT accepté après sélection de Paris). Les sondes visuelles à 390×844, 430×932 et 1280×900 n'ont pas été exécutées lors de la reprise : aucun navigateur connecté. Le placement réel des suggestions et leur visibilité au-dessus du footer restent à vérifier en navigateur.

### Comportements

1. **Suggestion choisie** : le nom de la commune est inséré.
2. **Texte valide sans clic** : il est utilisé tel quel ; la correspondance par mot, sans tenir compte des accents ni de la casse, le retrouve.
3. **Texte ne correspondant à aucune commune** : message « Aucune commune trouvée : le texte saisi sera utilisé tel quel. ». Le filtre renvoie simplement 0 résultat si rien ne correspond.
4. **Valeur historique libre** (ex. « Lyon (69) ») : elle n'est jamais réécrite sans sélection explicite et reste retrouvée par le filtre.

## 6. Rendu validé en navigateur réel

Validation faite avec Chrome headless, sur des copies statiques des pages. Les scripts applicatifs sont retirés, le vrai composant est chargé et `fetch` est simulé. Les pages sont affichées dans une iframe de 390×844 et 430×932, puis dans une fenêtre desktop de 1280×900.

Résultats pour les 4 champs :
- la liste est visible, avec 8 options de 44 px de hauteur minimum ;
- dans les feuilles de filtres, la première et la dernière option s'affichent au-dessus des boutons collants `.filt-actions` ;
- aucun ancêtre ne rogne les listes absolues ;
- il n'y a aucun défilement horizontal ;
- Échap ferme la liste.

PostgREST n'a pas été testé contre une base réelle.

## 7. Lot 7 — métiers / secteurs (READ OLD / WRITE CLEAN)

- Écriture : `canonicalizeTargetJobType` / `canonicalizeSector` inchangés ; seul alias ajouté :
  `SaaS` → `SaaS et Tech` (décision produit). Tech, Logiciel, Informatique, Industrie /
  Manufacturing… restent des valeurs distinctes. Inconnu conservé tel quel.
- Lecture / filtre (`utils/jobSectorFilter.js`) : jetons déclarés uniquement, règle de la
  taxonomie (trim + casse ; pas de repli d'accents, pas d'ID ADN, pas de sous-chaîne). Métier
  demandé par son libellé canonique → famille déclarée ; via un alias → libellé + cet alias
  (Sales Engineer ne retrouve pas Solutions Engineer). Secteur → famille complète.
- Offres : `imatch` PostgREST ancré (lettres non ASCII en classes explicites). Sourcing :
  post-filtre JS dans le scan borné existant (curseur = dernière ligne inspectée).
- Anonymat inchangé : seule la ville d'un anonyme est protégée ; métiers/secteurs ne sont
  affichés sur aucune carte et restent filtrables pour tous.
- Profil : une valeur hors liste enregistrée est affichée (chip active) et retirable.
- Aucune migration, aucun backfill. Tests : `test/jobSectorConsistency.test.js`.
