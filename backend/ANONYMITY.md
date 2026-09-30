# Anonymat candidat — contrat produit

Décision produit du 2026-09-30 (Lot 7.2). Règle historique, formalisée ici.

## Règle

L'anonymat protège le candidat pendant le **sourcing passif**. Tant qu'il n'a pas
volontairement postulé à l'offre d'un recruteur, son identité reste masquée dans le
deck sourcing de ce recruteur.

Une **candidature volontaire** (swipe droit / super du candidat sur une offre) vaut
révélation de son identité **au recruteur de cette offre uniquement**. Candidatures
reçues, pipeline, CV de candidature, messagerie et notifications associées
fonctionnent alors comme historiquement.

## Drapeau

`candidats.axes.meta.anonyme`. Sont anonymes : `true` et la forme historique
`"true"`. Toute autre valeur (`false`, `"false"`, `null`, absente, `1`, `"TRUE"`…)
ne l'est pas. Une seule lecture : `isAnonymousCandidate` (`utils/candidateDeckQuery.js`) ;
le filtre SQL localisation (`axes->meta->>anonyme`) donne `'true'` pour les deux formes.

L'interface candidat d'activation a été retirée le 2026-07-02 ; le drapeau subsiste
dans des profils historiques et reste accepté par `PUT /candidats/profil`.

## Deck sourcing (`GET /candidats/deck`) pour un profil anonyme

| Donnée | Exposée |
|---|---|
| Prénom, nom, initiales | non (`Candidat anonyme`, `?`) |
| Avatar | non |
| Ville | non, et jamais filtrable (le filtre localisation l'exclut) |
| CV (URL, nom de fichier) | non |
| Lettre : fichier, nom de fichier | non |
| Lettre : texte (`axes.meta.motivation`) | non (`letter_text` vide, jamais repris dans `pitch_text`) |
| E-mail, téléphone | jamais sélectionnés (aucun profil) |
| Titre, score ADN, axes, compétences, métiers/secteurs de matching | oui (données professionnelles) |
| `id`, `user_id` | oui : identifiants techniques nécessaires (swipe, déduplication) |

## Routes publiques ou transverses

- `GET /candidats/:id/certificat-public` (sans authentification, opt-in du candidat) :
  le prénom d'un profil anonyme n'est jamais renvoyé (`Un commercial`), sinon l'`id`
  visible dans le deck permettrait de ré-identifier la carte anonyme.
- `POST /recruteurs/swipe` : un match (et donc l'accès à l'identité via messagerie)
  n'est créé que sur une candidature volontaire du candidat ; les lignes historiques
  `recruteur_like` sont ignorées, comme dans `/candidatures/recues` et le pipeline.

## Après candidature volontaire

`/candidatures/recues`, `/recruteurs/pipeline`, `/recruteurs/pipeline/contact`,
`/messages/threads` et les événements Brevo `candidature_recue` / `match_cree`
révèlent l'identité au seul recruteur propriétaire de l'offre (contrôle par
`offres.recruteur_id`). Ils ne lisent pas le drapeau d'anonymat, par conception.

## Minimisation (indépendante de l'anonymat)

`/candidatures/recues` ne renvoie que les champs lus par son seul consommateur
(`renderRecues`, tableau de bord recruteur) : `id` (candidature), `name`, `av`, `bg`,
`titre`, `tags`, `score`, `hot`, `badge`, `badgeBg`, `badgeColor`. Plus de `snapshot`
brut (nom complet, ville, chemin du CV), d'identifiants candidat/offre ni de statut.
Le snapshot reste stocké en base et sert toujours au pipeline (CV de candidature).
Rien n'est modifié en base.

Tests : `test/recruiterPrivacy.test.js`, `test/jobSectorConsistency.test.js` (Lot 7.1).
