# SwipSales — Notes de contexte

Ce fichier résume les décisions et pièges accumulés au fil du développement, pour que Claude Code (ou n'importe qui reprend le projet) n'ait pas à tout redécouvrir. À tenir à jour au fil des sessions.

---

## Le projet

Recruitment SaaS façon "swipe" pour commerciaux (candidats) et recruteurs.
- **Backend** : Node.js/Express, hébergé sur Railway
- **Frontend** : HTML/JS vanilla (pas de framework), servi statiquement, hébergé avec le backend
- **DB/Auth/Storage** : Supabase
- **Paiement** : Stripe (abonnements recruteur uniquement — voir contrainte légale plus bas)
- **Email transactionnel** : Brevo (templates HTML custom + automatisations)
- **Monitoring** : Sentry (deux projets séparés : `swipsales-backend` et `swipsales-front`)
- **Repo** : `senyara-group/salesforge-recruitment`, branches `dev` → `preprod` → `master`

### Fichiers clés
- `backend/server.js` — point d'entrée, monte toutes les routes
- `backend/routes/` — une route par ressource (auth, offres, swipes, messages, recruteurs, candidats, abonnements, stripe...)
- `backend/middleware/auth.js` — middleware d'authentification (⚠️ voir piège ci-dessous)
- `frontend/swipsales_app.html` — shell d'authentification, charge candidat.html ou recruteur.html en iframe selon le rôle
- `frontend/_spaces/candidat.html` — SPA complète espace candidat (HTML+CSS+JS dans un seul fichier, ~3200 lignes)
- `frontend/_spaces/recruteur.html` — idem côté recruteur
- `frontend/swipsales_landing.html` — landing page marketing
- `frontend/swipsales_start.html` — inscription
- `frontend/swipsales_reset.html` — réinitialisation de mot de passe

---

## Pièges connus (déjà tombés dedans plusieurs fois)

1. **`backend/middleware/auth.js` vs `backend/routes/auth.js`** — deux fichiers du même nom dans deux dossiers différents. Un copier-coller dans le mauvais dossier a fait planter le serveur en prod à deux reprises (`TypeError: argument handler must be a function`). Toujours vérifier le dossier de destination avant de coller.

2. **Railway "Metal builder" bloqué en boucle** — bug d'infra Railway (pas notre code), le build reste coincé sur "scheduling build on Metal builder" sans jamais démarrer. Changer de builder (Railpack → Nixpacks) n'a pas aidé ; **changer de région de déploiement** a débloqué la situation. Si ça revient, retenter un changement de région avant de chercher ailleurs.

3. **Fichiers HTML massifs (3000+ lignes) et copier-coller mobile** — coller un gros fichier via l'éditeur web GitHub sur mobile peut tronquer silencieusement le contenu (a fait disparaître la barre de navigation une fois). Préférer "Upload files" (sélection directe du fichier) au copier-coller quand on n'a pas d'accès desktop/Claude Code.

4. **`avatar_url` recruteur n'est pas une vraie colonne** — c'est une URL signée Supabase Storage générée à la demande (24h d'expiration) à partir du champ `avatar_meta` (`{avatar_path, avatar_bucket}`). Ne jamais la sélectionner directement dans une requête Supabase (`.select('recruteurs(avatar_url)')` échoue) — il faut générer l'URL via `supabase.storage.from(bucket).createSignedUrl(path, ttl)`. Voir `attachRecruiterLogos()` dans `backend/routes/offres.js` pour le pattern (génération groupée, une fois par recruteur unique, pas par offre).

5. **Comptes créés via Google OAuth vs email/mot de passe suivent des chemins de code différents** — `POST /auth/signup` (email/mdp) envoie PRENOM/NOM à Brevo à l'inscription ; `POST /auth/exchange-code` (Google OAuth) ne le faisait pas historiquement (corrigé). Si un nouveau champ doit être synchronisé à l'inscription, penser aux **deux** chemins.

6. **Attributs de contact Brevo doivent être créés manuellement dans Brevo avant qu'une valeur envoyée par l'API ne les remplisse.** Si une automatisation Brevo a une variable vide, vérifier d'abord Contacts → Paramètres → Attributs de contact avant de chercher un bug côté code.

7. **`localStorage.sf_pending_role` périmé** — le bouton "Connexion Google" de la page de login (`swipsales_app.html`) doit toujours faire `localStorage.removeItem('sf_pending_role')` avant de rediriger vers Google, sinon un rôle mémorisé lors d'une inscription abandonnée peut s'appliquer par erreur à une connexion ultérieure sans rapport. Déjà corrigé, mais à garder en tête si un nouveau point d'entrée OAuth est ajouté.

---

## Contrainte légale (importante, en cours — septembre 2026)

Yannis a consulté un juriste : **il est interdit de faire payer un candidat pour tout ce qui touche à sa capacité de trouver/obtenir un emploi.**

### Doit rester gratuit et identique pour tous, sans exception (fait ✅)
Swipes, candidatures, accès aux offres, messagerie avec les recruteurs, visibilité auprès des entreprises, ordre d'apparition dans les résultats recruteur.
→ Toute logique de limite liée au plan (`abonnements.plan`) a été retirée de `backend/routes/swipes.js` et `backend/routes/messages.js`.
→ **(2026-09-03)** Deux résidus trouvés et corrigés en creusant la même contrainte :
  - `backend/routes/abonnements.js` (`GET /current`) renvoyait encore `swipes_m: plan==='freemium'?5:999`, ce qui affichait "X/5 swipes" aux candidats gratuits dans `candidat.html` alors que la limite n'existe plus côté backend. Corrigé → toujours `999`.
  - `backend/routes/candidats.js` calculait un badge `certifie` basé sur le plan payant (`gold`/`platine`) et l'exposait **au recruteur** dans le deck de swipe (`frontend/_spaces/recruteur.html`, badge doré "Certifié Swip Sales" sur la carte candidat). C'était une violation directe du garde-fou ci-dessous (l'abonnement candidat influençait ce que voit un recruteur). Retiré : `certifie` renvoie toujours `false` pour l'instant, badge recruteur supprimé, en attendant une éventuelle version conforme.

### Nouvelle structure tarifaire candidat (fait ✅ — 2026-09-03)
Landing page (`frontend/swipsales_landing.html`) et page pricing in-app (`frontend/_spaces/candidat.html`, section `PLANS`) alignées sur 3 paliers :
- **Compte candidat** (slug `freemium`, inchangé) — gratuit à vie, swipes/candidatures/messagerie illimités pour tous
- **Carrière** (slug `carriere`, ex-`premium` — même prix 19€/15€, même Stripe Price ID réutilisé)
- **Carrière Coaching** (slug `carriere_coaching`, ex-`platine` — même prix 79€/63€, même Stripe Price ID réutilisé)
- **Gold supprimé** (0 abonné actif au moment du retrait, vérifié en base avant suppression)
- 1 seul abonné actif migré `premium`→`carriere` en base (`abonnements`), aucun abonné actif `platine`/`gold` à migrer

### Peut rester payant — services autonomes, valeur hors plateforme (2026-09-05 : 6 des 8 construits, voir détail ci-dessous)
- ✅ Restitution PDF téléchargeable
- ✅ Re-passage / suivi tous les 6 mois avec historique
- ✅ Benchmark métier anonymisé par typologie de poste
- ✅ Chatbot coaching entretien — **ne recommande jamais d'offres ni ne fait de mise en relation** (contrainte imposée par prompt système, voir section "Fonctionnalités Carrière" ci-dessous)
- ✅ Certification SwipSales — atteste des compétences uniquement, **jamais** un placement ou une visibilité recruteur promis
- ✅ Optimisation CV/pitch spécifique profils commerciaux
- ⏳ Test ADN approfondi (60-80 items) — **contenu pas encore écrit**, en attente de Yannis/quelqu'un du métier (13 étapes/~20 items aujourd'hui, structure technique existante réutilisable)
- ⏳ Ebooks (négociation salariale, lecture d'un plan de commissionnement, 90 premiers jours) — **contenu pas encore écrit**, même attente

Les 2 items restants sont toujours marqués "Bientôt disponible" dans `candidat.html`/`swipsales_landing.html` — le badge a été retiré des 6 autres, désormais réellement fonctionnels.

### Garde-fous techniques à respecter pour toute nouvelle fonctionnalité payante candidat
- Le flag d'abonnement candidat ne doit **jamais** apparaître dans la logique de matching/ranking/droits de candidature — isolé strictement au déblocage de contenu/évaluation
- Rien côté recruteur ne doit exposer le statut d'abonné d'un candidat ni s'en servir comme critère de tri (⚠️ violé par le badge `certifie`, corrigé le 2026-09-03 — voir ci-dessus)
- RGPD : le scoring comportemental (test ADN) est une donnée sensible en contexte recrutement → consentement explicite requis, finalité déclarée, export/suppression possibles, **pas de décision automatisée de rejet sans intervention humaine** (✅ construit le 2026-09-04, voir section RGPD dédiée ci-dessous)
- Facturation : libellés orientés "accompagnement de carrière", jamais "premium plateforme"

### En attente
- CGU/CGV/RGPD (`frontend/swipsales_legal.html`) existent déjà et sont liées depuis le footer de la landing, mais portent un avertissement "modèle à personnaliser, à faire relire par un professionnel du droit avant mise en production" — à faire valider par un juriste si ce n'est pas déjà fait
- **Bug pricing recruteur "Partenaire" — code corrigé le 2026-09-03, reste des actions manuelles côté Stripe (checklist ci-dessous).** Le palier "Partenaire" (899€/719€ affichés, marque blanche/API ATS/SLA) mappait vers le slug Stripe `pro` (399€/319€) au lieu de `enterprise` — n'importe quel recruteur cliquant "Nous contacter" sur Partenaire était donc facturé au tarif Pro. Confirmé par Yannis : le prix affiché (899/719) est le bon, c'est Stripe qu'il faut mettre à jour, pas le site.
  - ✅ Fait : `frontend/_spaces/recruteur.html` → `selectPlan()` mappe maintenant `partenaire → 'enterprise'` (au lieu de `'pro'`). `backend/routes/stripe.js` avait déjà un emplacement `enterprise` prêt (`STRIPE_PRICE_RECRUTEUR_ENTERPRISE_MONTH`/`_YEAR`), aucun changement nécessaire côté backend.
  - ✅ Vérifié en base : 0 ligne `abonnements` avec `plan = 'enterprise'` — aucun abonné actif trouvé sur l'ancien tarif (mais la base peut être désynchronisée d'un abonnement Stripe réel, donc à revérifier directement dans Stripe avant de désactiver quoi que ce soit).
  - ⚠️ Non fait, nécessite un accès Stripe live que Claude Code n'a pas eu (seule une clé `sk_test_...` était disponible dans `backend/.env`) :
    1. Créer 2 nouveaux Price sur le produit **`prod_V7SXNGxr2hGgcy`** (Recruteur Enterprise) dans le Dashboard Stripe **(mode Live)** : mensuel **899,00 €**, annuel **8 628,00 €** (= 719€/mois, cohérent avec le -20% appliqué ailleurs). Les anciens Price (`price_1U7DbwLlKeTp7RSEBp7hKy1v` mensuel, `price_1U7DbwLlKeTp7RSE5ZcfATBB` annuel, 799€/7668€) restent inchangés — un Price Stripe est immuable, on n'en modifie pas un existant.
    2. Mettre à jour les variables d'environnement `STRIPE_PRICE_RECRUTEUR_ENTERPRISE_MONTH` et `STRIPE_PRICE_RECRUTEUR_ENTERPRISE_YEAR` sur Railway/Vercel (production) avec les deux nouveaux Price ID.
    3. Avant de désactiver les anciens Price : vérifier directement dans Stripe (pas seulement en base) qu'aucun abonnement actif ne les utilise encore.
    4. Désactiver (pas supprimer) les deux anciens Price une fois confirmé qu'ils sont inutilisés.
    5. Revenir ici mettre à jour cette note avec les nouveaux `price_id` une fois créés.

---

## Fonctionnalités Carrière / Carrière Coaching (construit le 2026-09-05)

Avant de construire : exploration complète du code existant (audit détaillé, pas de reconstruction à l'aveugle). Plan validé avec Guillaume : Phase A (aucun blocage) puis Phase B (nécessitait une décision — fournisseur LLM et propriété du contenu à rédiger).

### Décisions prises avec Guillaume
- **Fournisseur LLM : Claude (API Anthropic)**, clé fournie et ajoutée à `backend/.env` (`ANTHROPIC_API_KEY`, gitignored) + placeholder dans `.env.example`. Modèle utilisé : alias `claude-sonnet-4-5` (configurable via `ANTHROPIC_MODEL`), testé et fonctionnel.
- **Questionnaire ADN approfondi (60-80 items) et 3 nouveaux ebooks : contenu non rédigé par Claude Code**, en attente de Yannis/quelqu'un du métier — uniquement la structure technique existe (voir "Reste à faire" plus bas).

### Ce qui a été construit
- **Table `evaluations_adn`** (append-only, comme `consentements`) — `backend/supabase_evaluations_adn.sql`, **⚠️ à exécuter manuellement dans Supabase avant déploiement** (même principe que les précédents fichiers `.sql` du projet). Ajoute aussi une colonne `candidats.type_poste` (typologie de poste choisie pendant le test, auparavant enterrée sans être relue dans `axes.questionnaire.job_profile.poste`).
- **`backend/middleware/requireCandidatePlan.js`** — garde-fou générique (factory, `requireCandidatePlan('carriere')` ou `('carriere_coaching')`) pour le déblocage de contenu payant candidat. Repose sur `getCandidatePlan()` (nouveau, `backend/utils/profiles.js`). **Ne jamais s'en servir dans la logique de matching/swipes/candidatures/messagerie** (contrainte légale ci-dessus).
- **`POST /ai/score-adn`** (`backend/routes/ai.js`) : le premier passage reste libre pour tous (test gratuit). Un repassage (score déjà existant) nécessite Carrière Coaching + un délai de 6 mois depuis la dernière évaluation (vérifié en base, pas seulement côté frontend). Chaque passage insère désormais une ligne dans `evaluations_adn` en plus de mettre à jour `candidats.axes.resultat` (qui reste la "dernière" valeur, pour ne rien casser côté `GET /candidats/deck` recruteur).
- **`backend/routes/candidats.js`**, nouveaux endpoints :
  - `GET /evaluations` (Carrière Coaching) — historique + `peut_repasser`/`next_eligible_at`.
  - `GET /export-pdf` (Carrière) — génère un PDF à la volée avec `pdfkit` (pas de stockage, pas de nettoyage à gérer) à partir du dernier résultat.
  - `GET /benchmark` (Carrière Coaching) — moyenne anonymisée par `type_poste`, **seuil k≥5** : renvoie explicitement "pas assez de données" en dessous, jamais un chiffre qui identifierait 1-4 personnes précises. Suit le pattern d'agrégation déjà utilisé par `POST /recruteurs/matching-count`.
  - `GET /profil` : `certifie` est maintenant un vrai booléen calculé (`plan === carriere_coaching` ET `score_adn ≥ 80`) — **mais uniquement ici**, sur le propre profil du candidat. `GET /deck` (recruteur) reste hardcodé à `certifie: false`, inchangé — ne jamais reconnecter cette valeur côté recruteur (c'est exactement ce qui avait été corrigé le 2026-09-03).
  - `GET /certification` + `POST /certification/partage` — le partage public est **opt-in explicite** (désactivé par défaut), pas opt-out.
  - `GET /:id/certificat-public` — endpoint public (sans auth), ne renvoie que prénom + score, 404 si non certifié ou partage désactivé. Nouvelle page statique `frontend/certificat.html` (pas d'intégration LinkedIn OAuth — volontairement retirée du projet par le passé — l'utilisateur poste lui-même le lien).
  - `POST /optimiser-cv` (Carrière) — réutilise le CV déjà stocké si aucun fichier n'est envoyé dans la requête, sinon accepte un nouvel upload. Relecture par Claude, retour de suggestions structurées (jamais une réécriture automatique).
  - `POST /optimiser-pitch` (Carrière) — même principe sur un texte libre collé par le candidat (pas de champ pitch existant à réutiliser, `axes.meta.motivation` existe côté backend mais n'était alimenté par aucune UI).
- **`backend/routes/coaching.js`** (était un stub 30 lignes, quasi vide) : `GET/POST/DELETE /chat` (Carrière Coaching) — chatbot avec historique de conversation stocké dans `candidats.axes.meta.coaching_chat` (pas de nouvelle table). Prompt système strict : ne recommande jamais d'offre, ne met jamais en relation avec un recruteur, n'a accès à aucune donnée d'offre/recruteur réelle — uniquement de l'entraînement (entretiens, objections, négociation, pitch).
- **Frontend `frontend/_spaces/candidat.html`** : écran de blocage avant repassage du test (même mécanisme que le consentement RGPD, intercepté dans `prepareTestPage()`) ; boutons Export PDF / Benchmark / Mon évolution sur l'écran de résultat ; section "Certification SwipSales" avec toggle de partage dans les paramètres ; boutons "Optimiser" sur le CV et nouveau champ pitch dans les paramètres ; widget de chat dans la page Ressources (`#p-coaching`, remplace l'ancien stub qui ne faisait rien).

### Reste à faire / à valider
- **Exécuter `backend/supabase_evaluations_adn.sql` dans Supabase avant tout déploiement** — sans ça, `evaluations_adn`/`type_poste` n'existent pas (le code dégrade proprement : `POST /ai/score-adn` logue juste un avertissement et continue de fonctionner pour le score lui-même, mais aucun historique ni benchmark ne fonctionnera).
- Coût Anthropic à surveiller — pas de plafond/rate-limit ajouté côté candidat au-delà du gating par plan (Carrière Coaching pour le chat, Carrière pour l'optimisation CV/pitch). À voir si un quota mensuel devient nécessaire selon l'usage réel.
- Questionnaire ADN approfondi (60-80 items) et les 3 ebooks : contenu à écrire par Yannis/quelqu'un du métier, badge "Bientôt disponible" conservé jusque-là.
- Benchmark actuellement peu utile en pratique : seulement 9 candidats en base au 2026-09-05, 3 avec un score, répartis sur 6 typologies possibles — aucun bucket n'atteindra le seuil k≥5 avant un vrai volume d'utilisateurs.
- Seuil de certification (`score_adn ≥ 80`) choisi arbitrairement par Claude Code faute de critère métier fourni — à valider/ajuster avec Yannis.

---

## RGPD — scoring comportemental candidat (construit le 2026-09-04)

Suite de la même consultation juriste que la contrainte tarifaire ci-dessus. Méthode suivie : audit de l'existant avant toute construction, aucun texte légal rédigé comme définitif, questions posées à Guillaume sur les points ambigus (schéma de la table de consentement, stratégie de suppression, délai de suppression, traitement de la donnée envoyée à Brevo) avant de coder.

### Ce qui a été audité avant de construire
- **Consentement** : recherche de "consentement" dans tout le code — rien, pas même une case CGU à l'inscription (`frontend/swipsales_start.html` n'a aucune case à cocher). Chantier entièrement neuf, pas seulement pour le test ADN.
- **Finalité déclarée** : `backend/routes/ai.js` envoie le score comme **attribut de contact persistant** à Brevo (`SCORE_ADN`), pas juste un événement ponctuel — techniquement segmentable dans des campagnes email. Décision de Guillaume : on garde tel quel, le texte de consentement le dit honnêtement plutôt que de prétendre "jamais que le matching". Trouvé au passage (non traité, hors scope du test ADN) : `frontend/swipsales_legal.html` Article 4 ("Destinataires des données") ne mentionne pas Brevo alors que des données personnelles y transitent en continu — à corriger séparément.
  - Aussi noté pour info : le calcul du score (`POST /ai/score-adn`) est aujourd'hui un placeholder (`65 + longueur des réponses / 80`, plafonné à 95), pas une vraie analyse comportementale. Ne change rien légalement mais évite de survendre "analyse IA poussée" dans un texte.
- **Export/suppression** : aucune route `DELETE` sur le compte, aucun export existant, seule la résiliation Stripe (qui n'arrête que la facturation). Confirmé par recherche large dans `backend/routes/`.
- **Décision automatisée de rejet (Article 22 RGPD) : rien trouvé — bonne nouvelle.** Vérifié sous plusieurs angles : `GET /candidats/deck` (ce que voit le recruteur) sélectionne tous les candidats et trie par score sans jamais filtrer ; `compatibilityScore()` est un pourcentage affiché, jamais un filtre ; aucune candidature n'est auto-rejetée (statut par défaut toujours `envoyee`) ; recherche de `reject|seuil|threshold` dans tout `backend/` sans résultat pertinent. Le recruteur voit toujours tout le monde et décide lui-même (swipe pass/like/super = décision humaine).

### Ce qui a été construit
1. **Table `consentements`** (append-only, une ligne par action de consentement, jamais d'update) — schéma dans `backend/supabase_rgpd_consentement.sql`. **⚠️ À exécuter manuellement dans le Supabase SQL Editor avant de merger/déployer** — la table n'existe pas encore, les nouvelles routes plus bas échoueront tant que ce n'est pas fait (même principe que `supabase_swipe_message_fixes.sql`, pas de migration automatique dans ce projet).
2. **Écran de consentement avant le test ADN** (`frontend/_spaces/candidat.html`, div `#test-consent-gate` dans `#p-test`) : case à cocher non pré-cochée, "Refuser" (retour à l'accueil, utilisation normale de SwipSales inchangée) ou "Accepter et commencer". Intercepté au niveau du routeur `go()` (fonction `prepareTestPage`), donc couvre toutes les façons d'arriver sur la page test (clic direct, lien profil, hash URL, `?start=test`). **Texte marqué BROUILLON dans le code — à valider par Yannis/un juriste avant prod.**
3. **Garde-fou côté serveur** dans `backend/routes/ai.js` (`POST /ai/score-adn`) : revérifie qu'un consentement `accepte=true` existe avant de calculer/enregistrer le score, indépendamment de l'écran frontend (qui pourrait être contourné par un appel API direct).
4. **Endpoints** (`backend/routes/candidats.js`) :
   - `GET /candidats/consentement/:type` et `POST /candidats/consentement` — lire/écrire le consentement.
   - `GET /candidats/export` — export JSON (profil, résultat et réponses du test ADN, compétences, candidatures, matchs, historique de consentements).
   - `DELETE /candidats/compte` — suppression de compte, confirmation `{confirmation:'SUPPRIMER'}` revérifiée côté serveur.
5. **Boutons dans les paramètres candidat** (`frontend/_spaces/candidat.html`, panneau `profile-edit-panel`, section "Mes données (RGPD)") : "Exporter mes données (JSON)" et "Supprimer mon compte" (confirmation par saisie du mot "SUPPRIMER" dans un `prompt()`, pas un simple clic).

### Décisions prises avec Guillaume (à connaître si on retouche ce chantier)
- **Score → Brevo** : gardé tel quel (voir ci-dessus), le texte de consentement le divulgue.
- **Stockage du consentement** : table dédiée plutôt que JSONB sur `candidats`, pour un historique complet non écrasable.
- **Suppression liée (matchs/candidatures/messages)** : anonymiser plutôt que supprimer les lignes, pour ne pas casser l'affichage des conversations/matchs passés côté recruteur. Concrètement : la ligne `candidats` est vidée de ses données personnelles (nom, prénom, titre, CV, score, réponses au test) mais **conservée** (garde son `id`) ; idem pour `users` (email remplacé par un placeholder, ligne conservée) puisque `messages.sender_id`/`receiver_id` référencent `users.id` directement. Les fichiers réels (CV, lettre, photo) sont eux vraiment supprimés du storage. L'identité Supabase Auth est vraiment supprimée (`auth.admin.deleteUser`) — connexion définitivement impossible. Le contenu des messages déjà envoyés n'est pas effacé (pour ne pas casser l'affichage du fil de discussion côté recruteur) ; à revoir si ça pose un problème.
- **Délai de suppression** : immédiat après confirmation, pas de délai de grâce ni de traitement différé.
- Les lignes `consentements` d'un compte supprimé sont conservées (preuve qu'un consentement a bien été obtenu à l'époque), même si le reste est anonymisé.
- Comportement à connaître : un candidat qui avait déjà passé le test **avant** ce chantier (score déjà en base) sera lui aussi bloqué par l'écran de consentement la première fois qu'il retourne sur la page test après le déploiement — c'est voulu (régularise rétroactivement le consentement pour des données déjà collectées), mais ça vaut le coup de le savoir si quelqu'un s'étonne de revoir cet écran.

### Reste à faire / à valider avant merge
- Exécuter `backend/supabase_rgpd_consentement.sql` dans Supabase (obligatoire, sinon les nouvelles routes échouent).
- Faire valider le texte de l'écran de consentement (`#test-consent-gate` dans `candidat.html`) par Yannis/un juriste.
- Décider si `frontend/swipsales_legal.html` Article 4 doit être mis à jour pour mentionner Brevo comme destinataire (trouvé pendant cet audit, pas corrigé — nécessite aussi un texte juridique, donc pas fait sans validation).
- Tester en conditions réelles une fois la table créée : consentement → test → export → suppression de compte, notamment que `auth.admin.deleteUser` fonctionne bien avec la clé de service utilisée en production.

---

## Modèle d'abonnement recruteur (inchangé, toujours payant)

Le recruteur n'a pas de palier gratuit — `requireRecruiterPlan` (middleware) bloque l'accès sans abonnement actif. C'est distinct de la contrainte légale ci-dessus, qui ne concerne que les candidats.

---

## Divers

- **Sentry** : deux projets configurés et fonctionnels (backend + frontend). En cas d'erreur suspecte côté client, vérifier `swipsales-front` avant de chercher à l'aveugle.
- **Design system** : tokens CSS dans `:root` de chaque fichier HTML (`--b` bleu marque, `--sh-*` échelle d'ombres). Rester cohérent entre `candidat.html` et `recruteur.html` — même palette, mêmes conventions.
- **Le repo est parfois public, parfois privé** — si un agent ne peut pas cloner, redemander à ce qu'il soit repassé en public temporairement.