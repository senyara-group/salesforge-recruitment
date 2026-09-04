const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { getUserEmail } = require('../utils/profiles');
const { trackBrevoEvent } = require('../utils/brevoEvents');

const stripePrices = {
  cand: {
    // 'carriere' et 'carriere_coaching' réutilisent les Price ID Stripe existants
    // (Premium et Platine) : tarifs inchangés, seul le nom candidat a changé.
    month: {
      carriere: process.env.STRIPE_PRICE_CANDIDAT_PREMIUM_MONTH,
      carriere_coaching: process.env.STRIPE_PRICE_CANDIDAT_PLATINE_MONTH,
    },
    year: {
      carriere: process.env.STRIPE_PRICE_CANDIDAT_PREMIUM_YEAR,
      carriere_coaching: process.env.STRIPE_PRICE_CANDIDAT_PLATINE_YEAR,
    },
  },
  rec: {
    month: {
      solo: process.env.STRIPE_PRICE_RECRUTEUR_SOLO_MONTH,
      starter: process.env.STRIPE_PRICE_RECRUTEUR_STARTER_MONTH,
      pro: process.env.STRIPE_PRICE_RECRUTEUR_PRO_MONTH,
      enterprise: process.env.STRIPE_PRICE_RECRUTEUR_ENTERPRISE_MONTH,
    },
    year: {
      solo: process.env.STRIPE_PRICE_RECRUTEUR_SOLO_YEAR,
      starter: process.env.STRIPE_PRICE_RECRUTEUR_STARTER_YEAR,
      pro: process.env.STRIPE_PRICE_RECRUTEUR_PRO_YEAR,
      enterprise: process.env.STRIPE_PRICE_RECRUTEUR_ENTERPRISE_YEAR,
    },
  },
};

const checkoutPlans = {
  cand: {
    month: {
      carriere: { name: 'Candidat Carrière', amount: 1900 },
      carriere_coaching: { name: 'Candidat Carrière Coaching', amount: 7900 },
    },
    year: {
      carriere: { name: 'Candidat Carrière annuel', amount: 1500 },
      carriere_coaching: { name: 'Candidat Carrière Coaching annuel', amount: 6300 },
    },
  },
  rec: {
    month: {
      solo: { name: 'Recruteur Entrepreneur / Indépendant', amount: 8900 },
      starter: { name: 'Recruteur Starter', amount: 14900 },
      pro: { name: 'Recruteur Pro', amount: 39900 },
      enterprise: { name: 'Recruteur Enterprise', amount: 79900 },
    },
    year: {
      solo: { name: 'Recruteur Entrepreneur / Indépendant annuel', amount: 7100 },
      starter: { name: 'Recruteur Starter annuel', amount: 11900 },
      pro: { name: 'Recruteur Pro annuel', amount: 31900 },
      enterprise: { name: 'Recruteur Enterprise annuel', amount: 63900 },
    },
  },
};

function getFrontendUrl(req) {
  return process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
}

function createCheckoutSession({ req, priceId, checkoutPlan, userId, plan, type, period }) {
  const frontendUrl = getFrontendUrl(req);
  const lineItem = priceId
    ? { price: priceId, quantity: 1 }
    : {
      price_data: {
        currency: 'eur',
        recurring: { interval: period === 'year' ? 'year' : 'month' },
        unit_amount: period === 'year' ? checkoutPlan.amount * 12 : checkoutPlan.amount,
        product_data: { name: checkoutPlan.name },
      },
      quantity: 1,
    };

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [lineItem],
    success_url: `${frontendUrl}/swipsales_app.html?payment=success`,
    cancel_url: `${frontendUrl}/pricing`,
    metadata: {
      plan,
      type,
      period,
      ...(userId ? { userId } : {}),
    },
    // Sans ceci, les métadonnées ne vivent que sur la session ponctuelle : les
    // webhooks customer.subscription.updated/deleted (mise à jour, résiliation)
    // ne recevraient jamais userId et resteraient inopérants.
    subscription_data: {
      metadata: {
        plan,
        type,
        period,
        ...(userId ? { userId } : {}),
      },
    },
  });
}

// Redirection publique vers Stripe Checkout depuis la landing ou les pages statiques
router.get('/checkout', async (req, res) => {
  try {
    const type = req.query.type === 'rec' ? 'rec' : 'cand';
    const period = req.query.period === 'month' ? 'month' : 'year';
    const plan = String(req.query.plan || '').toLowerCase();

    if (plan === 'freemium') {
      return res.redirect(process.env.FREEMIUM_REDIRECT_URL || `${getFrontendUrl(req)}/swipsales_start.html?role=candidat`);
    }

    const priceId = stripePrices[type]?.[period]?.[plan];
    const checkoutPlan = checkoutPlans[type]?.[period]?.[plan];

    if (!priceId && !checkoutPlan) {
      return res.status(400).json({
        error: 'Plan Stripe introuvable',
        plan,
        type,
        period,
      });
    }

    const session = await createCheckoutSession({ req, priceId, checkoutPlan, plan, type, period });
    res.redirect(session.url);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Creer un lien de paiement Stripe Checkout
router.post('/create-checkout', authMiddleware, async (req, res) => {
  try {
    const { priceId, plan, billing, type } = req.body;
    const checkoutType = type === 'rec' ? 'rec' : 'cand';
    const period = billing === 'month' ? 'month' : 'year';
    const normalizedPlan = String(plan || '').toLowerCase();

    const configuredPriceId = priceId || stripePrices[checkoutType]?.[period]?.[normalizedPlan];
    const checkoutPlan = checkoutPlans[checkoutType]?.[period]?.[normalizedPlan];

    if (!configuredPriceId && !checkoutPlan) {
      return res.status(400).json({ error: 'Plan Stripe introuvable' });
    }

    const session = await createCheckoutSession({
      req,
      priceId: configuredPriceId,
      checkoutPlan,
      userId: req.user.id,
      plan: normalizedPlan || 'custom',
      type: checkoutType,
      period,
    });

    res.json({ url: session.url });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Résilier l'abonnement — reste actif jusqu'à la fin de la période déjà payée
router.post('/cancel-subscription', authMiddleware, async (req, res) => {
  try {
    const { data: abonnement, error: abonnementError } = await supabase
      .from('abonnements')
      .select('stripe_customer_id, plan, statut')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (abonnementError) return res.status(400).json({ error: abonnementError });
    if (!abonnement?.stripe_customer_id || abonnement.plan === 'freemium') {
      return res.status(400).json({ error: 'Aucun abonnement payant actif à résilier' });
    }

    const subscriptions = await stripe.subscriptions.list({
      customer: abonnement.stripe_customer_id,
      status: 'active',
      limit: 1,
    });

    const subscription = subscriptions.data[0];
    if (!subscription) {
      return res.status(400).json({ error: 'Aucun abonnement Stripe actif trouvé pour ce compte' });
    }

    const updated = await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: true,
    });

    // La base est mise à jour par le webhook customer.subscription.updated
    // (source de vérité unique) ; on renvoie ici la date de fin pour un retour
    // immédiat à l'utilisateur sans attendre le webhook.
    res.json({
      message: 'Résiliation enregistrée',
      date_fin: updated.current_period_end
        ? new Date(updated.current_period_end * 1000).toISOString()
        : null,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// IMPORTANT: cette route doit recevoir le raw body, configure dans server.js.
router.post('/webhook', async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    // Événement le plus fiable — paiement confirmé
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan;
      const period = session.metadata?.period || 'month';

      if (!userId || !plan) {
        console.warn('Webhook checkout.session.completed — userId ou plan manquant', session.metadata);
        return res.json({ received: true });
      }

      await supabase.from('abonnements').upsert({
        user_id: userId,
        stripe_customer_id: session.customer,
        plan,
        statut: 'actif',
        periode: period,
      }, { onConflict: 'user_id' });

      getUserEmail(userId).then((email) => {
        trackBrevoEvent(email, 'abonnement_active', { plan }, {
          ABONNEMENT_PLAN: plan,
          ABONNEMENT_STATUT: 'actif',
        }).catch(() => {});
      }).catch(() => {});
    }

    // Mise à jour abonnement (upgrade / downgrade / renouvellement / résiliation programmée)
    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const userId = sub.metadata?.userId;
      const plan = sub.metadata?.plan || sub.items.data[0]?.price?.nickname;

      if (!userId) {
        console.warn('Webhook subscription.updated — userId manquant');
        return res.json({ received: true });
      }

      const statut = sub.status === 'active' ? 'actif' : 'inactif';
      const dateFin = sub.cancel_at_period_end && sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;

      // On lit l'état précédent pour ne déclencher l'événement de résiliation qu'une seule fois.
      const { data: previous } = await supabase
        .from('abonnements')
        .select('resiliation_programmee')
        .eq('user_id', userId)
        .maybeSingle();
      const wasAlreadyFlagged = Boolean(previous?.resiliation_programmee);

      await supabase.from('abonnements').upsert({
        user_id: userId,
        stripe_customer_id: sub.customer,
        plan,
        statut,
        periode: sub.metadata?.period || 'month',
        date_fin: dateFin,
        resiliation_programmee: Boolean(sub.cancel_at_period_end),
      }, { onConflict: 'user_id' });

      getUserEmail(userId).then((email) => {
        trackBrevoEvent(email, 'abonnement_mis_a_jour', { plan, statut }, {
          ABONNEMENT_PLAN: plan,
          ABONNEMENT_STATUT: statut,
          ABONNEMENT_DATE_FIN: dateFin || '',
        }).catch(() => {});

        // Scénario 04-D : entrée dans le suivi "avant fin d'abonnement" — une seule fois.
        if (sub.cancel_at_period_end && !wasAlreadyFlagged) {
          trackBrevoEvent(email, 'resiliation_enregistree', { date_fin: dateFin }, {
            ABONNEMENT_DATE_FIN: dateFin || '',
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    // Annulation abonnement — repasse en freemium
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const userId = sub.metadata?.userId;

      if (!userId) {
        console.warn('Webhook subscription.deleted — userId manquant');
        return res.json({ received: true });
      }

      await supabase.from('abonnements').upsert({
        user_id: userId,
        stripe_customer_id: sub.customer,
        plan: 'freemium',
        statut: 'actif',
        periode: 'month',
        date_fin: null,
        resiliation_programmee: false,
      }, { onConflict: 'user_id' });

      // Scénario 04-E : point de départ du délai de 30 jours avant réactivation à froid.
      getUserEmail(userId).then((email) => {
        trackBrevoEvent(email, 'abonnement_termine', {}, {
          ABONNEMENT_PLAN: 'freemium',
          ABONNEMENT_STATUT: 'termine',
        }).catch(() => {});
      }).catch(() => {});
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;