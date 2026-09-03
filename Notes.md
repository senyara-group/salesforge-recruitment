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

### Peut rester payant — services autonomes, valeur hors plateforme (à construire, rien n'existe encore côté code)
- Test ADN approfondi (60-80 items) + restitution PDF téléchargeable
- Re-passage / suivi tous les 6 mois avec historique
- Benchmark métier anonymisé par typologie de poste
- Chatbot coaching entretien — **ne doit jamais recommander d'offres ni faire de mise en relation**, coaching uniquement
- Ebooks (négociation salariale, lecture d'un plan de commissionnement, 90 premiers jours)
- Certification SwipSales — atteste des compétences uniquement, **jamais** un placement ou une visibilité recruteur promis
- Optimisation CV/pitch spécifique profils commerciaux

### Garde-fous techniques à respecter pour toute nouvelle fonctionnalité payante candidat
- Le flag d'abonnement candidat ne doit **jamais** apparaître dans la logique de matching/ranking/droits de candidature — isolé strictement au déblocage de contenu/évaluation
- Rien côté recruteur ne doit exposer le statut d'abonné d'un candidat ni s'en servir comme critère de tri
- RGPD : le scoring comportemental (test ADN) est une donnée sensible en contexte recrutement → consentement explicite requis, finalité déclarée, export/suppression possibles, **pas de décision automatisée de rejet sans intervention humaine** (⚠️ pas encore implémenté, à faire)
- Facturation : libellés orientés "accompagnement de carrière", jamais "premium plateforme"

### En attente
- Yannis doit envoyer la nouvelle landing page / structure tarifaire candidat avant de retoucher `frontend/_spaces/candidat.html` (section `PLANS`) et la page pricing
- Volet RGPD (consentement, export/suppression, pas de rejet auto) pas encore traité

---

## Modèle d'abonnement recruteur (inchangé, toujours payant)

Le recruteur n'a pas de palier gratuit — `requireRecruiterPlan` (middleware) bloque l'accès sans abonnement actif. C'est distinct de la contrainte légale ci-dessus, qui ne concerne que les candidats.

---

## Divers

- **Sentry** : deux projets configurés et fonctionnels (backend + frontend). En cas d'erreur suspecte côté client, vérifier `swipsales-front` avant de chercher à l'aveugle.
- **Design system** : tokens CSS dans `:root` de chaque fichier HTML (`--b` bleu marque, `--sh-*` échelle d'ombres). Rester cohérent entre `candidat.html` et `recruteur.html` — même palette, mêmes conventions.
- **Le repo est parfois public, parfois privé** — si un agent ne peut pas cloner, redemander à ce qu'il soit repassé en public temporairement.