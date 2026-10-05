# Activité recruteur et Kanban — audit et contrat du correctif

Base auditée : `f9f76757b6b4cac5abaf90b569b594a5ef46dca8` (`origin/master` après fetch).
Branche : `codex/recruiter-dashboard-kanban`. Aucun merge, déploiement ou accès à une DB distante.

## Navigation existante

Les écrans sont dans `frontend/_spaces/recruteur.html` : pages `#p-*`, fonction `go`, navigation `#bnav`.
Le conteneur public `frontend/swipsales_app.html` charge l'espace dans une iframe de hauteur `100dvh`.
Le style combine le CSS inline et `frontend/app-professional.css` ; barre basse sous 1024 px, sidebar à partir de 1024 px (220 px, puis 236 px à partir de 1280).

| Écran / DOM | Rendu / actions JS | Routes et données | Desktop / mobile avant correctif |
|---|---|---|---|
| Activité `#p-dashboard` | `loadDashboard`, `renderDashStats`, `renderRecues`, `renderDashRecentOffers` | GET `/recruteurs/stats`, `/candidatures/recues?limit=4`, `/offres/mine` | Hero, 4 KPI, actions/sourcing, 2 listes ; grilles puis empilement |
| Candidats / sourcing `#p-swipe` | `loadCandidates`, `renderDeck`, `doSwipe` | GET `/candidats/deck`, POST `/recruteurs/swipe` | Carte horizontale sur ordinateur, verticale mobile ; filtres en sheet |
| Matching `#p-matching` | `renderMatching`, `saveMatching` | POST `/recruteurs/matching-count`, PUT `/recruteurs/profil` | Paramétrage existant, aucun changement de formule |
| Pipeline `#p-pipeline` | `loadPipeline`, `loadMorePipeline`, `renderPipeline`, `openPipelineCandidate` | GET `/recruteurs/pipeline` ; candidatures et contexte `/offres/mine` | 3 puis 6 colonnes comprimées ; défilement horizontal mobile ; cartes non déplaçables |
| Fiche candidat `#cand-ov` | `renderPipelineStatusOptions`, `updatePipelineStatus`, `saveCandidateNote`, `contactFromPipeline` | PUT `/candidatures/:id/status`, `/:id/note`, POST `/recruteurs/candidat-vu`, `/pipeline/contact` | Overlay commun ; statut, note, CV et conversation |
| Offres `#p-offres` | `loadOffers`, `renderOffers`, `editOffer` | GET `/offres/mine`, DELETE `/offres/:id`, PATCH `/offres/:id/status` | Cartes en grille puis pile |
| Création / édition `#p-post-offre` | `submitOffer`, `editOffer` | POST `/offres`, PUT `/offres/:id` | Formulaire existant |
| Messages `#p-messages` | `loadMessages`, `openThread`, `loadThreadMessages`, `sendMessage` | GET `/messages/threads`, `/thread/:id`, POST `/messages/send` | Liste et fil côte à côte desktop ; navigation liste/fil mobile |
| Questions `#p-questions` | `loadQuestions`, `saveQuestions` | GET `/recruteurs/questions`, PUT `/recruteurs/profil` | Sélection existante commune aux deux formats |
| Réglages `#p-settings`, tarifs `#p-pricing` | `renderAccountSettings`, `renderPlans` | API auth/abonnement/Stripe existantes | Inchangés et hors périmètre |

Il n'existe pas d'écran autonome « contacts », « shortlist », « entretiens » ou « recrutements » : ces notions ne doivent pas devenir des tables/statuts inventés.

## Statuts réellement trouvés

Toutes les lignes ci-dessous ont pour source `candidatures.statut`. Les accents concernent les libellés, pas les valeurs stockées. `applicationWorkflow.js` contient les transitions ; `pipelineQuery.js` regroupe les étapes.

| Statut UI / colonne | Valeur backend | Table | Colonne | Routes | Écran |
|---|---|---|---|---|---|
| Candidature envoyée / Nouveaux | `envoyee` (NULL lu comme envoyé) | candidatures | statut | GET pipeline, PUT status, DELETE candidature | Pipeline, fiche, candidatures candidat |
| À examiner / Nouveaux | `nouveau` | candidatures | statut | idem + POST candidat-vu | idem |
| Profil consulté / À qualifier | `vu` | candidatures | statut | idem + POST candidat-vu | idem |
| Contacté / Contactés | `contacte` | candidatures | statut | GET pipeline, PUT status | idem |
| Réponse reçue / Contactés | `repondu` | candidatures | statut | GET pipeline, PUT status | idem |
| Entretien / Entretiens | `entretien` | candidatures | statut | GET pipeline, PUT status | idem |
| Proposition envoyée / Propositions | `offre` | candidatures | statut | GET pipeline, PUT status | idem |
| Recruté / Terminées | `embauche` | candidatures | statut | GET pipeline, PUT status | idem |
| Non retenu / Terminées | `refusee` | candidatures | statut | GET pipeline, PUT status | idem |
| Retirée / Terminées | `retiree` | candidatures | statut | GET pipeline, DELETE candidature (candidat uniquement) | idem |

Le fallback historique d'un statut inconnu vers « Terminées » est conservé, sans autoriser de transition depuis cette valeur. Pas d'alias sémantique ajouté. « Qualifié » n'est pas `vu` : le libellé existant est bien « À qualifier ».

## Source de vérité et autorisation

Le recruteur agit sur une **candidature à une offre**, pas globalement sur une personne. Deux candidatures de la même personne à deux offres sont légitimes.
Les lectures excluent `lettre_type = recruteur_like` et sont limitées aux offres détenues par le recruteur. `matchs`/`messages` servent à la conversation et au score déjà existant, pas au statut. Contacter via la messagerie ne fait pas automatiquement passer à `contacte`.

Le frontend ne fait aucune écriture Supabase directe de statut. Realtime écoute les INSERT de messages/candidatures pour notifier ; aucun abonnement UPDATE de statut, RPC de déplacement ou trigger de workflow n'a été trouvé dans le dépôt.
Le serveur utilise une clé de service : les contrôles de rôle, plan et propriété d'offre restent indispensables et sont exercés par les tests HTTP. Le fichier SQL historique `recruitment_integrity_migration.sql` énumère les dix valeurs autorisées. Le dépôt ne permet pas de certifier les policies RLS réellement installées sur la DB distante ; aucun audit distant ni migration n'a été effectué.

## Diagnostic Activité et choix

Activité était déjà un dashboard partiel. Le bloc promotionnel de sourcing occupait la zone où manquait la synthèse des étapes. Les paddings desktop inline + thème s'additionnaient. La largeur disponible devenait moins utile, avec seulement quelques données récentes.
Aucun verrou de scroll vertical propre à Activité n'a été trouvé ; le document conserve une hauteur naturelle, mais toutes les barres de défilement étaient masquées. Le symptôme précis de la démo n'est pas démontré comme une panne de scroll sur cette base.

Le correctif remplace le bloc promotionnel par six volumes d'étape cliquables, conserve les quatre KPI et au maximum deux listes inférieures (offres et candidatures récentes). Le CSS recruteur borne la largeur, enlève le double padding et rend le scroll identifiable. Aucune série temporelle, conversion, date d'entretien ou activité fictive n'est créée.

Provenance : offres actives = `offres.statut=active` du recruteur ; reçues/pipeline = candidatures hors likes recruteur ; récentes = `created_at` des sept derniers jours ; chauds = `repondu` + `entretien` (formule conservée) ; étapes = regroupement exact de `statut` par `stageForStatut`.
Les agrégats utilisent des COUNT exacts, sans plafond de lignes PostgREST et sans renvoyer d'identité candidat. Ils sont partagés entre Activité et les compteurs du pipeline. « chargée(s) » distingue les cartes de la page courante du total.

## Contrat des déplacements

- Même route `PUT /candidatures/:id/status` et mêmes transitions irréversibles. `/recruteurs/pipeline/move` reste inutilisée/verrouillée.
- Les options `moves` sont produites par le workflow serveur ; pas de seconde table de transitions dans le frontend.
- Un drag desktop vers une étape autorisée déplace puis persiste. Une issue terminale demande le choix explicite « Recruté » / « Non retenu » lorsque applicable ; jamais de refus ou recrutement implicite.
- Chaque carte possède un select natif « Déplacer vers… », également disponible sur mobile/clavier. Le tactile garde le scroll ; le drag n'est activé qu'au pointeur fin à partir de 1024 px.
- Un seul enregistrement en vol par carte ; la carte est temporairement verrouillée. D'autres cartes peuvent être enregistrées en parallèle. Les chargements attendent les écritures ; les générations empêchent les réponses de lecture anciennes de repeindre un état récent.
- Rollback par carte et inversion des seuls compteurs concernés, sans restaurer un snapshot global. Réconciliation avec le serveur après erreur, y compris un succès serveur dont la réponse a été perdue. Si la réconciliation échoue, les écritures restent bloquées jusqu'à actualisation.
- Vérification atomique de l'ancien statut dans l'UPDATE ; conflit 409 si une consultation, un retrait ou une autre session a changé le statut. Le retrait candidat reçoit le même garde-fou pour ne pas écraser une prise de contact concurrente.
- Ordre inchangé : `created_at DESC NULLS LAST, id DESC`. Fusion des pages dédupliquée par ID de candidature, pas par ID de personne. Aucun ordre manuel ni migration.

## Validation reproductible

`node --test test/recruiterKanban.test.js test/recruiterKanbanRoutes.test.js` : comportement du module utilisé par l'UI, vrai rendu des KPI, transitions, concurrence/rollback, HTTP Express avec vrais middlewares auth/plan/profil et doubles des seuls services externes ; 2503 candidatures pour le plafond PostgREST.

`node scripts/check-recruiter-kanban-layout.js` : Chrome/Edge headless local, fixtures sans donnée distante, tailles 1280×900, 1440×900, 768×1024, 390×844, 430×932. Mesures DOM, scroll haut/milieu/bas, colonnes chargées/vides, événements DragEvent/DataTransfer desktop, select mobile, succès et erreur simulée, captures PNG et rapport dans un répertoire temporaire annoncé à la fin.
`npm run test:layout` conserve intégralement ses assertions existantes ; seules ses fonctions utilitaires sont exportées pour réutilisation.

Les tests navigateur ne valident pas un geste physique sur téléphone ni une écriture dans la DB distante. Les polices/CDN distants sont bloqués dans la sonde dédiée pour rendre le test autonome. Les agrégats sont plusieurs lectures exactes, pas un snapshot transactionnel entre plusieurs sessions : une actualisation remet les compteurs à jour. Pas de diffusion Realtime des changements d'étape ajoutée.

Hors périmètre : abonnements/Stripe, IA candidat, scoring ADN, taxonomies, formules de matching, tri manuel, calendrier d'entretiens. `docs/review-coach-ia-cv-yannis.md` reste intact et exclu du commit.
