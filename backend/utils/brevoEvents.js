// Pont entre le produit et Brevo Automation.
//
// Ce module ne construit AUCUN scénario : il alimente Brevo avec deux choses,
// que les workflows (construits dans l'éditeur Brevo, cf. doc "SwipSales Scenarios
// automation") utilisent ensuite comme déclencheurs et conditions :
//
//   1. des événements traçables (trackBrevoEvent) — déclenchent l'entrée/la sortie
//      d'un scénario ("compte_candidat_cree", "test_adn_termine", ...)
//   2. des attributs de contact à jour (upsertBrevoContact) — utilisés dans les
//      branches SI/SINON des workflows ("score_adn > 0", "swipes_used >= 5", ...)
//
// Best-effort partout : si BREVO_API_KEY n'est pas configurée, ou si l'appel
// échoue, on log un warning et on continue — un incident Brevo ne doit jamais
// faire échouer une action produit (inscription, swipe, envoi de message...).

const BREVO_API_BASE = 'https://api.brevo.com/v3';

function apiKey() {
  return process.env.BREVO_API_KEY || null;
}

async function brevoRequest(path, method, body) {
  const key = apiKey();
  if (!key) return false;

  try {
    const response = await fetch(`${BREVO_API_BASE}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'api-key': key,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.warn(`Brevo API ${method} ${path} -> ${response.status}: ${detail}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`Brevo API ${method} ${path} a echoue:`, error.message || error);
    return false;
  }
}

// Crée le contact s'il n'existe pas, met à jour ses attributs sinon (updateEnabled).
// `attributes` : clés en MAJUSCULES par convention Brevo (ex: SCORE_ADN, TEST_ADN_TERMINE).
async function upsertBrevoContact(email, attributes = {}) {
  if (!email) return false;
  return brevoRequest('/contacts', 'POST', {
    email,
    attributes,
    updateEnabled: true,
  });
}

// Déclenche un événement traçable sur ce contact (entrée/sortie/branche de scénario).
// `eventProperties` : données ponctuelles liées à CET événement (ex: score obtenu ce jour-là).
// `contactProperties` : si fournies, mettent aussi à jour les attributs du contact en un seul appel.
async function trackBrevoEvent(email, eventName, eventProperties = {}, contactProperties = {}) {
  if (!email) return false;
  const body = {
    event_name: eventName,
    identifiers: { email_id: email },
    event_properties: eventProperties,
  };
  if (Object.keys(contactProperties).length) {
    body.contact_properties = contactProperties;
  }
  return brevoRequest('/events', 'POST', body);
}

module.exports = { upsertBrevoContact, trackBrevoEvent };
