# SalesForge Recruitment

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

## Pages principales

- `salesforge_landing.html`
- `salesforge_start.html`
- `salesforge_app.html`
