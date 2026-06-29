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
    const profileSwipesUsed = await getCandidateSwipeUsage(req.user.id);
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
