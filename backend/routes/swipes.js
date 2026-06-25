const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureCandidateProfile } = require('../utils/profiles');

function appendUnique(values = [], value) {
  return [...new Set([...values.map(String), String(value)])];
}

async function markOfferSeen(candidat, offreId) {
  const axes = candidat.axes || {};
  const meta = axes.meta || {};
  const nextAxes = {
    ...axes,
    meta: {
      ...meta,
      swiped_offer_ids: appendUnique(meta.swiped_offer_ids || [], offreId),
    },
  };

  const { error } = await supabase
    .from('candidats')
    .update({ axes: nextAxes })
    .eq('id', candidat.id);

  if (error) throw error;
}

router.post('/', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const { offre_id, action } = req.body;

    if (!offre_id) return res.status(400).json({ error: 'offre_id requis' });
    await markOfferSeen(candidat, offre_id);
    if (action === 'pass') return res.json({ match: false });

    const { data: existingCandidature } = await supabase
      .from('candidatures')
      .select('id')
      .eq('candidat_id', candidat.id)
      .eq('offre_id', offre_id)
      .maybeSingle();

    const candidatureQuery = existingCandidature
      ? supabase.from('candidatures').update({ statut: 'envoyee', lettre_type: 'auto' }).eq('id', existingCandidature.id)
      : supabase.from('candidatures').insert({
        candidat_id: candidat.id,
        offre_id,
        statut: 'envoyee',
        lettre_type: 'auto',
      });

    const { error: candidatureError } = await candidatureQuery;

    if (candidatureError) return res.status(400).json({ error: candidatureError });

    const score = action === 'super' ? 95 : 85;
    const { data: existingMatch } = await supabase
      .from('matchs')
      .select('id')
      .eq('candidat_id', candidat.id)
      .eq('offre_id', offre_id)
      .maybeSingle();

    const matchQuery = existingMatch
      ? supabase.from('matchs').update({ score_match: score, score_compat: score }).eq('id', existingMatch.id)
      : supabase.from('matchs').insert({
        candidat_id: candidat.id,
        offre_id,
        score_match: score,
        score_compat: score,
      });

    const { data: match, error: matchError } = await matchQuery
      .select('*')
      .single();

    if (matchError) return res.status(400).json({ error: matchError });
    res.json({ match: true, ...match });
  } catch (error) {
    res.status(400).json({ error });
  }
});

module.exports = router;
