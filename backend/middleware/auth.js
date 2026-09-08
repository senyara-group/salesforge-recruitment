const { createClient } = require('@supabase/supabase-js');

// Un seul client pour tout le process. Auparavant `createClient` etait appele a
// chaque requete authentifiee, ce qui instanciait un client GoTrue par appel.
let cachedClient = null;

function getAuthClient() {
  if (!cachedClient) {
    cachedClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      // Verification de token uniquement : ce client ne doit jamais conserver la
      // session du dernier appelant (il est partage par toutes les requetes).
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
  return cachedClient;
}

// Statuts pour lesquels GoTrue a reellement refuse le token (signature invalide,
// token expire, utilisateur supprime...). Tout le reste est une panne.
//
// Comportement reel de @supabase/auth-js (voir lib/fetch.js) :
//  - echec de fetch (reseau, DNS, timeout)  -> AuthRetryableFetchError, status 0
//  - 502/503/504/520-530                    -> AuthRetryableFetchError, status HTTP
//    ("These are infrastructure errors and should not cause session invalidation")
//  - tout le reste, Y COMPRIS 429 et 500    -> AuthApiError
// Un 429 (rate limit GoTrue) ou un 500 remontent donc comme n'importe quelle
// erreur d'API : sans ce tri ils etaient renvoyes au client en 401, ce qui faisait
// passer une panne d'infrastructure pour une session expiree.
const TOKEN_REJECTED_STATUSES = new Set([400, 401, 403, 404, 422]);

function isTokenRejection(error) {
  if (TOKEN_REJECTED_STATUSES.has(error?.status)) return true;
  // Erreurs levees localement par auth-js sur un JWT malforme.
  return /InvalidJwt|SessionMissing/.test(error?.name || '');
}

// Detail technique pour les logs serveur uniquement : jamais renvoye au client,
// et ne contient jamais le token.
function technicalDetail(error) {
  return {
    name: error?.name || null,
    status: error?.status ?? null,
    code: error?.code || null,
    message: String(error?.message || 'Unknown error').slice(0, 300),
  };
}

async function callGetUser(token) {
  try {
    const result = await getAuthClient().auth.getUser(token);
    return { user: result?.data?.user || null, error: result?.error || null };
  } catch (error) {
    // getUser ne devrait pas rejeter, mais une panne ne doit jamais remonter en
    // 500 non gere ni etre confondue avec un refus de token.
    return { user: null, error };
  }
}

// MAX_ATTEMPTS = 2 : une seule nouvelle tentative, pour absorber un incident
// transitoire (blip reseau, 429 ponctuel) sans allonger durablement la requete.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 150;

async function verifyToken(token) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const { user, error } = await callGetUser(token);

    if (user && !error) return { user, error: null, rejected: false };

    // GoTrue a repondu sans erreur mais sans utilisateur : anormal, et on ne peut
    // pas authentifier -> refus. Jamais d'acces accorde par defaut.
    if (!error) return { user: null, error: null, rejected: true };

    if (isTokenRejection(error)) return { user: null, error, rejected: true };

    lastError = error;
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  return { user: null, error: lastError, rejected: false };
}

module.exports = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorise', code: 'TOKEN_MISSING' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Configuration Supabase manquante' });
  }

  const { user, error, rejected } = await verifyToken(token);

  if (user) {
    req.user = user;
    return next();
  }

  if (rejected) {
    // Anonyme, token falsifie ou session expiree : le seul cas qui merite un 401.
    return res.status(401).json({ error: 'Token invalide', code: 'TOKEN_INVALID' });
  }

  // Panne de verification (GoTrue injoignable, rate limite, 5xx). Le token n'est
  // pas en cause : renvoyer 401 ici deconnectait l'utilisateur a tort et masquait
  // l'incident. Le detail reste dans les logs serveur.
  console.error('[auth] verification indisponible', technicalDetail(error));
  return res.status(503).json({
    error: 'Verification de session temporairement indisponible',
    code: 'AUTH_UNAVAILABLE',
  });
};
