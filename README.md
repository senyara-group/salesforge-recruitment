# Swip Sales Recruitment

## Lancer le projet en local

1. Aller dans le backend:

```powershell
cd backend
```

2. Installer les dependances si besoin:

```powershell
npm install
```

3. Copier `backend/.env.example` vers `backend/.env`, puis remplir les valeurs Supabase et Stripe.

4. Lancer le serveur:

```powershell
npm run dev
```

5. Ouvrir l'application:

```text
http://localhost:3000
```

Le backend sert aussi les fichiers HTML du dossier `frontend`.

## Variables a remplir

Les valeurs obligatoires pour l'authentification et les donnees sont:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY`

Les valeurs Stripe sont necessaires uniquement pour les paiements et les abonnements.

## CV IA et Coach IA

Les deux outils utilisent une API serveur compatible avec le format Chat Completions. Aucun appel fournisseur n'est effectue depuis le navigateur.

1. Appliquer manuellement `backend/ai_features_migration.sql` et `backend/recruitment_integrity_migration.sql` au projet Supabase de developpement.
2. Configurer `AI_API_KEY`, `AI_API_URL` et `AI_MODEL` dans `backend/.env`.
3. Laisser `AI_CV_ACCESS_PLANS=*` et `AI_COACH_ACCESS_PLANS=*` pour autoriser tous les candidats, ou fournir une liste explicite de plans separes par des virgules.

Sans clé ou modèle, les écrans restent consultables mais indiquent que le service IA n'est pas configuré et aucun résultat fictif n'est produit. Le choix commercial des plans autorisés reste donc centralisé dans la configuration, sans quota affiché comme une offre officielle.

Pour tester :

```powershell
cd backend
npm test
npm run dev
```

Dans l'espace candidat, ouvrir `CV IA` pour importer, corriger, analyser et exporter le texte. Ouvrir `Coach IA` pour créer une conversation et choisir explicitement le profil, le CV ou une offre comme contexte.

## Deploiement Vercel

Le projet peut etre deploye directement sur Vercel depuis la racine du repo.
Vercel sert les pages du dossier `frontend` et expose le backend Express via `/api`.

Dans Vercel, verifier:

- Root Directory: racine du repo, pas seulement `frontend`
- Environment Variables: recopier les valeurs de `backend/.env.example`
- `FRONTEND_URL=https://www.swipsales.fr`
- `OAUTH_REDIRECT_URL=https://www.swipsales.fr/swipsales_app.html`
- `PASSWORD_RESET_REDIRECT_URL=https://www.swipsales.fr/swipsales_reset.html`

## Pages principales

- `swipsales_landing.html`
- `swipsales_start.html`
- `swipsales_app.html`
