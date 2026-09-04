const { getCandidatePlan } = require('../utils/profiles');

const PLAN_RANK = { freemium: 0, carriere: 1, carriere_coaching: 2 };

// Garde-fou pour le déblocage de contenu "développement de carrière" payant
// (historique du test, export PDF, benchmark, certification...). Ne JAMAIS s'en
// servir pour les swipes/candidatures/messagerie/matching — contrainte légale,
// voir Notes.md "Contrainte légale".
module.exports = function requireCandidatePlan(minPlan) {
  return async (req, res, next) => {
    try {
      const plan = await getCandidatePlan(req.user.id);
      if ((PLAN_RANK[plan] ?? 0) < PLAN_RANK[minPlan]) {
        return res.status(403).json({
          error: 'PLAN_REQUIRED',
          message: minPlan === 'carriere_coaching'
            ? 'Cette fonctionnalité nécessite l\'abonnement Carrière Coaching'
            : 'Cette fonctionnalité nécessite l\'abonnement Carrière ou Carrière Coaching',
        });
      }
      req.candidatePlan = plan;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message || 'Erreur vérification abonnement' });
    }
  };
};
