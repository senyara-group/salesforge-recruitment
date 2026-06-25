const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');

const stripePrices = {
  cand: {
    month: {
      premium: process.env.STRIPE_PRICE_CANDIDAT_PREMIUM_MONTH,
      gold: process.env.STRIPE_PRICE_CANDIDAT_GOLD_MONTH,
      platine: process.env.STRIPE_PRICE_CANDIDAT_PLATINE_MONTH,
    },
    year: {
      premium: process.env.STRIPE_PRICE_CANDIDAT_PREMIUM_YEAR,
      gold: process.env.STRIPE_PRICE_CANDIDAT_GOLD_YEAR,
      platine: process.env.STRIPE_PRICE_CANDIDAT_PLATINE_YEAR,
    },
  },
  rec: {
    month: {
      starter: process.env.STRIPE_PRICE_RECRUTEUR_STARTER_MONTH,
      pro: process.env.STRIPE_PRICE_RECRUTEUR_PRO_MONTH,
      enterprise: process.env.STRIPE_PRICE_RECRUTEUR_ENTERPRISE_MONTH,
    },
    year: {
      starter: process.env.STRIPE_PRICE_RECRUTEUR_STARTER_YEAR,
      pro: process.env.STRIPE_PRICE_RECRUTEUR_PRO_YEAR,
      enterprise: process.env.STRIPE_PRICE_RECRUTEUR_ENTERPRISE_YEAR,
    },
  },
};

const checkoutPlans = {
  cand: {
    month: {
      premium: { name: 'Candidat Premium', amount: 1900 },
      gold: { name: 'Candidat Gold', amount: 3900 },
      platine: { name: 'Candidat Platine', amount: 7900 },
    },
    year: {
      premium: { name: 'Candidat Premium annuel', amount: 1500 },
      gold: { name: 'Candidat Gold annuel', amount: 3100 },
      platine: { name: 'Candidat Platine annuel', amount: 6300 },
    },
  },
  rec: {
    month: {
      starter: { name: 'Recruteur Starter', amount: 14900 },
      pro: { name: 'Recruteur Pro', amount: 39900 },
      enterprise: { name: 'Recruteur Enterprise', amount: 79900 },
    },
    year: {
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
        recurring: { interval: 'month' },
        unit_amount: checkoutPlan.amount,
        product_data: { name: checkoutPlan.name },
      },
      quantity: 1,
    };

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [lineItem],
    success_url: `${frontendUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}/pricing`,
    metadata: {
      plan,
      type,
      period,
      ...(userId ? { userId } : {}),
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
      return res.redirect(process.env.FREEMIUM_REDIRECT_URL || `${getFrontendUrl(req)}/salesforge_start.html?role=candidat`);
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

// IMPORTANT: cette route doit recevoir le raw body, configure dans server.js.
router.post('/webhook', async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'customer.subscription.created') {
      const sub = event.data.object;

      await supabase.from('abonnements').upsert({
        user_id: sub.metadata?.userId || null,
        stripe_customer_id: sub.customer,
        plan: sub.metadata?.plan || sub.items.data[0].price.nickname,
        statut: 'actif',
        periode: sub.metadata?.period || 'month',
      });
    }

    if (event.type === 'customer.subscription.deleted') {
      // Repasser l'utilisateur en Freemium
    }

    res.json({ received: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
