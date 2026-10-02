// Catalogue des formules vendables en self-service : seule source serveur des
// tarifs et des Price ID Stripe. Les montants sont en centimes par mois ; en
// annuel, Stripe facture annualMonthlyCents × 12 (voir routes/stripe.js).
// Tarifs : Notes.md « Nouvelle structure tarifaire candidat » et landing page.
const CHECKOUT_CATALOG = Object.freeze({
  cand: Object.freeze({
    // 'carriere' et 'carriere_coaching' réutilisent les Price ID Stripe existants
    // (Premium et Platine) : tarifs inchangés, seul le nom candidat a changé.
    carriere: Object.freeze({ name: 'Candidat Carrière', monthlyCents: 1900, annualMonthlyCents: 1500, priceEnv: 'CANDIDAT_PREMIUM' }),
    carriere_coaching: Object.freeze({ name: 'Candidat Carrière Coaching', monthlyCents: 7900, annualMonthlyCents: 6300, priceEnv: 'CANDIDAT_PLATINE' }),
  }),
  rec: Object.freeze({
    solo: Object.freeze({ name: 'Recruteur Entrepreneur / Indépendant', monthlyCents: 8900, annualMonthlyCents: 7100, priceEnv: 'RECRUTEUR_SOLO' }),
    starter: Object.freeze({ name: 'Recruteur Starter', monthlyCents: 14900, annualMonthlyCents: 11900, priceEnv: 'RECRUTEUR_STARTER' }),
    pro: Object.freeze({ name: 'Recruteur Pro', monthlyCents: 39900, annualMonthlyCents: 31900, priceEnv: 'RECRUTEUR_PRO' }),
    enterprise: Object.freeze({ name: 'Recruteur Enterprise', monthlyCents: 79900, annualMonthlyCents: 63900, priceEnv: 'RECRUTEUR_ENTERPRISE' }),
  }),
});

const CHECKOUT_PERIODS = Object.freeze(['month', 'year']);
const ROLE_CHECKOUT_TYPES = Object.freeze({ candidat: 'cand', recruteur: 'rec' });
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['actif', 'active', 'trialing']);

function checkoutTypeForRole(role) {
  return Object.hasOwn(ROLE_CHECKOUT_TYPES, role) ? ROLE_CHECKOUT_TYPES[role] : null;
}

/**
 * Résout une formule du catalogue. Retourne null pour tout ce qui n'y figure pas
 * (formule historique, autre espace, périodicité inconnue) : le client ne choisit
 * jamais un Price ID ni un montant, seulement un slug validé ici.
 */
function resolveCheckoutPlan({ type, plan, period, env = process.env }) {
  if (!Object.hasOwn(CHECKOUT_CATALOG, type) || !CHECKOUT_PERIODS.includes(period)) return null;
  const slug = String(plan || '').trim().toLowerCase();
  if (!Object.hasOwn(CHECKOUT_CATALOG[type], slug)) return null;
  const entry = CHECKOUT_CATALOG[type][slug];
  const annual = period === 'year';
  return {
    type,
    plan: slug,
    period,
    priceId: env[`STRIPE_PRICE_${entry.priceEnv}_${annual ? 'YEAR' : 'MONTH'}`] || null,
    checkoutPlan: {
      name: annual ? `${entry.name} annuel` : entry.name,
      amount: annual ? entry.annualMonthlyCents : entry.monthlyCents,
    },
  };
}

/** Un abonnement payant en cours : un nouveau checkout créerait un 2ᵉ abonnement Stripe. */
function hasActivePaidSubscription(abonnement) {
  const plan = String(abonnement?.plan || 'freemium').trim().toLowerCase();
  const status = String(abonnement?.statut || abonnement?.status || '').trim().toLowerCase();
  return plan !== 'freemium' && ACTIVE_SUBSCRIPTION_STATUSES.has(status);
}

module.exports = {
  CHECKOUT_CATALOG,
  CHECKOUT_PERIODS,
  checkoutTypeForRole,
  resolveCheckoutPlan,
  hasActivePaidSubscription,
};
