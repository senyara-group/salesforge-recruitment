const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

async function getCandidateSwipeUsage(userId) {
  const { data, error } = await supabase
    .from('candidats')
    .select('axes')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  const meta = data?.axes?.meta || {};
  return meta.swipes_month === currentMonthKey() ? Number(meta.swipes_used || 0) : 0;
}

router.get('/current', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('abonnements')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) return res.status(400).json({ error });
    const abonnement = data[0] || { plan: 'freemium', statut: 'actif', periode: 'month' };

    // Le calcul des swipes n'a de sens que pour un compte candidat : un compte
    // recruteur n'a pas de fiche candidats, et une erreur ici (ex: état de
    // données incohérent) ne doit jamais empêcher l'affichage de l'abonnement.
    let profileSwipesUsed = 0;
    try {
      profileSwipesUsed = await getCandidateSwipeUsage(req.user.id);
    } catch (swipeError) {
      console.warn('getCandidateSwipeUsage a echoue (ignore, compte probablement recruteur):', swipeError.message || swipeError);
    }

    const swipesUsed = Math.max(Number(abonnement.swipes_u || 0), profileSwipesUsed);
    res.json({
      ...abonnement,
      swipes_u: swipesUsed,
      swipes_m: abonnement.plan === 'freemium' ? 5 : 999,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || error });
  }
});

module.exports = router;