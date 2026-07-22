const supabase = require('../supabase');

module.exports = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('abonnements')
      .select('plan, statut')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) throw error;

    const abonnement = data?.[0];

    // Aucun abonnement ou plan invalide
    if (!abonnement || !['solo', 'starter', 'pro', 'enterprise'].includes(abonnement.plan)) {
      return res.status(403).json({
        error: 'PLAN_REQUIRED',
        message: 'Un abonnement recruteur est requis pour accéder à cette fonctionnalité'
      });
    }

    // Abonnement expiré ou inactif
    if (abonnement.statut !== 'actif') {
      return res.status(403).json({
        error: 'PLAN_INACTIVE',
        message: 'Votre abonnement recruteur est inactif ou expiré'
      });
    }

    // Attacher le plan à la requête pour l'utiliser dans les routes
    req.recruiterPlan = abonnement.plan;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erreur vérification abonnement' });
  }
};