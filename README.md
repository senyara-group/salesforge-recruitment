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