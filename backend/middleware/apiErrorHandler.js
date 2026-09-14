// Filet de securite final pour /api/* : sans ce gestionnaire, une erreur qui
// echappe aux routes (body JSON malforme, payload trop volumineux pour
// express.json()...) tombe sur la page HTML par defaut d'Express. Le frontend
// (fonction api() dans les SPA) fait systematiquement un JSON.parse de la
// reponse ; face a du HTML ça echoue silencieusement et affiche un message
// generique sans aucune information exploitable. On force donc une reponse
// JSON ici, pour les routes /api/* uniquement (les pages statiques gardent le
// comportement par defaut d'Express).
module.exports = function apiErrorHandler(err, req, res, next) {
  if (!req.path.startsWith('/api/')) return next(err);
  if (res.headersSent) return next(err);
  const status = Number(err?.status || err?.statusCode) || 500;
  console.error('[server] erreur non geree avant reponse', {
    path: req.path,
    method: req.method,
    status,
    name: err?.name || null,
    message: String(err?.message || err).slice(0, 300),
  });
  res.status(status).json({
    error: status === 413 ? 'Contenu trop volumineux.' : 'Erreur serveur. Veuillez réessayer.',
    code: 'SERVER_ERROR',
  });
};
