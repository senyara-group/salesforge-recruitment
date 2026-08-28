// Doit être importé tout en haut de server.js, avant tout autre require.
const Sentry = require("@sentry/node");

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // Désactive Sentry si la variable n'est pas configurée (ex: en local),
  // plutôt que de faire échouer le démarrage du serveur.
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.NODE_ENV || "production",
  sendDefaultPii: false, // ne pas envoyer automatiquement les données utilisateur (RGPD)
});