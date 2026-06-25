const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');

router.get('/current', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('abonnements')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) return res.status(400).json({ error });
  const abonnement = data[0] || { plan: 'freemium', statut: 'actif', periode: 'month' };
  res.json({
    ...abonnement,
    swipes_u: abonnement.swipes_u || 0,
    swipes_m: abonnement.plan === 'freemium' ? 5 : 999,
  });
});

module.exports = router;
