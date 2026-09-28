# Localisation (Lot 2)

Base : origin/master 283dc11450ffcda5c3ad8ad21d9b93d094fa8b98.
Aucune migration, aucun backfill, aucune donnée réécrite. Aucun déploiement.

## Cartographie avant ce lot

| Concept | Stockage | Format | Écrans |
| --- | --- | --- | --- |
| Localisation actuelle du candidat | `candidats.axes.meta.ville` (jsonb) | texte libre ; saisie profil avec suggestions geo.api.gouv.fr (nom de commune seul) ; inscription (`POST /auth/register`) | profil candidat, complétude, export RGPD |
| Localisation de l'offre | `offres.lieu` (text) | texte libre ≤ 100, requis à la création/édition ; suggestions « Ville » (geo.api.gouv.fr), « Remote / Télétravail », « France entière » | création/édition offre, cartes Opportunités, listes recruteur, candidatures, matchs |
| Mode de travail | `offres.remote_mode` | `onsite` \| `hybrid` \| `remote` \| NULL | offre, filtre Opportunités « Mode de travail » |
| Mobilité / rayon | `candidats.mobility_km` (int) | écrivable par l'API profil, **aucun écran** | aucun |
| Codes / coordonnées | `offres.city_code/latitude/longitude`, `candidats.city_code/latitude/longitude` | colonnes additives (`filter_foundation_migration.sql`), **jamais alimentées** par un écran | aucun |
| Localisation souhaitée | n'existe pas en tant que champ | — | — |

Données historiques possibles : `lieu` NULL/vide (offres antérieures à la validation),
libellés libres (« Lyon (69) », « Paris 15e », « France entière », « Remote / Télétravail ») ;
`ville` absente, vide, ou non textuelle (jsonb libre). Anciennes offres avec `lieu` contenant
« remote » ont reçu `remote_mode = 'remote'` (migration filter_foundation, déjà appliquée ou non).

Comparaisons existantes : aucune. Aucun filtre localisation, aucun rayon, aucun calcul de
distance. La localisation n'intervient dans **aucun** score (compatibilityScore,
score_match/score_compat, ADN, Deep ADN) : cas B.

## Sources de vérité retenues

- Offre : `offres.lieu` (valeur source affichée telle quelle, espaces normalisés).
- Candidat : `candidats.axes.meta.ville` (ville déclarée).
- `remote_mode` reste un filtre distinct (« Mode de travail ») : un filtre localisation
  « Lyon » n'inclut pas automatiquement les offres en télétravail.
- `city_code`, `latitude`, `longitude`, `mobility_km` : non utilisés (vides en pratique).

## Filtre

`utils/locationFilter.js` (seul point de normalisation) :

- paramètre `location` sur `GET /offres/deck` (candidat) et `GET /candidats/deck` (recruteur) ;
- chaîne uniquement (tableau/objet/nombre ⇒ 400 `LOCATION_FILTER_INVALID`), espaces
  normalisés, 80 caractères max, lettres (accents compris), chiffres, espace, tiret,
  apostrophes `'` `’`, point, parenthèses, `/` ; 1 à 6 mots ;
- correspondance : mots entiers, dans l'ordre, séparateurs quelconques ; insensible à la
  casse et aux accents par le motif (`[eéèêëEÉÈÊË]`…), la valeur stockée n'est jamais modifiée ;
  « saint etienne » ⇒ « Saint-Étienne » ; « lyon » ⇒ « Lyon (69) » mais pas « Lyonnais » ;
- aucune équivalence géographique : Paris ≠ Île-de-France, Lille ≠ 59, Valenciennes ≠ Nord ;
- exécuté en SQL (PostgREST `match`, regex POSIX) avant `limit`/curseur : pagination, tri et
  autres filtres inchangés ; même motif en JS (`locationTextMatches`) pour les matchers.
  Le motif ne contient que des classes explicites, aucun caractère de la saisie brute.
- valeur absente/vide/non textuelle : exclue uniquement quand le filtre est actif ;
- candidat anonyme (`axes.meta.anonyme`) : ville jamais affichée et jamais filtrable
  (exclu dès qu'un filtre localisation est actif, sinon le résultat révélerait la ville) ;
- sourcing : post-filtre JS en plus du SQL, car `axes->meta->>ville` convertit un
  nombre/objet JSON en texte côté PostgreSQL.

## Affichage

- Opportunités : lieu complet (et non plus le premier mot dans l'écran de match),
  « Lieu non précisé » si absent, mode de travail (Sur site / Hybride / Télétravail) en badge.
- Sourcing : ville déclarée sur la carte (champ `location`), vide pour un anonyme.
  Aucune adresse, aucune coordonnée. Les candidatures exposaient déjà la ville dans le
  snapshot (`applicationWorkflow`), inchangé.
- Création/édition d'offre : inchangée (champ Localisation requis + suggestions).
- Filtres : section « Localisation » avec aide et état vide explicite ; sélection conservée
  pendant la session comme les autres filtres (non persistée au rechargement, comme eux).

## Reporté

- Rayon / distance : nécessite des coordonnées fiables. Piste : enregistrer `city_code`
  (code INSEE) et coordonnées renvoyés par geo.api.gouv.fr au moment de la saisie (offre et
  profil), backfill séparé et vérifiable, puis filtre `mobility_km`/rayon côté SQL.
- Localisation souhaitée du candidat (distincte de la ville actuelle) : décision produit.
- Matching : la localisation pourrait devenir un critère (bonus « même ville » ou pénalité
  hors rayon) dans un lot dédié, avec poids explicite et tests de non-régression du score.
- Recherche multi-villes (OU), départements/régions via référentiel officiel.
- Formes NFD stockées (« E » + accent combinant) et ligatures (œ) : non couvertes par le
  motif ; rares dans les données issues de geo.api.gouv.fr.
- Validation du motif sur la base réelle (PostgreSQL ARE) : à contrôler sur un
  environnement de préproduction avant mise en production.
