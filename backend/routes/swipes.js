const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureCandidateProfile } = require('../utils/profiles');

const FREE_SWIPES_MONTHLY = 5;

function appendUnique(values = [], value) {
  return [...new Set([...values.map(String), String(value)])];
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function swipeUsage(candidat) {
  const month = currentMonthKey();
  const meta = candidat.axes?.meta || {};
  return meta.swipes_month === month ? Number(meta.swipes_used || 0) : 0;
}

async function getSubscriptionPlan(userId) {
  const { data, error } = await supabase
    .from('abonnements')
    .select('plan')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw error;
  return data[0]?.plan || 'freemium';
}

function assertSwipeAllowed(candidat, plan) {
  if (plan !== 'freemium') return;
  if (swipeUsage(candidat) >= FREE_SWIPES_MONTHLY) {
    const error = new Error('Limite Freemium atteinte : passez a un plan payant pour continuer a swiper');
    error.status = 402;
    throw error;
  }
}

async function markOfferSeenAndCount(candidat, offreId) {
  const axes = candidat.axes || {};
  const meta = axes.meta || {};
  const month = currentMonthKey();
  const currentUsed = meta.swipes_month === month ? Number(meta.swipes_used || 0) : 0;
  const nextAxes = {
    ...axes,
    meta: {
      ...meta,
      swiped_offer_ids: appendUnique(meta.swiped_offer_ids || [], offreId),
      swipes_month: month,
      swipes_used: currentUsed + 1,
    },
  };

  const { error } = await supabase
    .from('candidats')
    .update({ axes: nextAxes })
    .eq('id', candidat.id);

  if (error) throw error;
  return nextAxes.meta;
}

function includesId(values = [], ids = []) {
  const set = new Set(values.filter(Boolean).map(String));
  return ids.filter(Boolean).some((id) => set.has(String(id)));
}

async function upsertCandidature(candidatId, offreId, action) {
  const { data: existingCandidature } = await supabase
    .from('candidatures')
    .select('id')
    .eq('candidat_id', candidatId)
    .eq('offre_id', offreId)
    .maybeSingle();

  const payload = {
    statut: 'envoyee',
    lettre_type: action === 'super' ? 'prioritaire' : 'auto',
  };

  const candidatureQuery = existingCandidature
    ? supabase.from('candidatures').update(payload).eq('id', existingCandidature.id)
    : supabase.from('candidatures').insert({
      candidat_id: candidatId,
      offre_id: offreId,
      ...payload,
    });

  const { error } = await candidatureQuery;
  if (error) throw error;
}

router.post('/', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const { offre_id, action } = req.body;

    if (!offre_id) return res.status(400).json({ error: 'offre_id requis' });
    if (!['like', 'super', 'pass'].includes(action)) {
      return res.status(400).json({ error: 'Action de swipe invalide' });
    }

    const plan = await getSubscriptionPlan(req.user.id);
    assertSwipeAllowed(candidat, plan);

    const { data: offre, error: offreError } = await supabase
      .from('offres')
      .select('id, auto_candidature, recruteurs(id, matching, questions)')
      .eq('id', offre_id)
      .maybeSingle();

    if (offreError) return res.status(400).json({ error: offreError });
    if (!offre) return res.status(404).json({ error: 'Offre introuvable' });

    const usage = await markOfferSeenAndCount(candidat, offre_id);
    if (action === 'pass') return res.json({ match: false });

    const candidatureSent = Boolean(offre.auto_candidature || action === 'super');
    if (candidatureSent) await upsertCandidature(candidat.id, offre_id, action);

    const score = action === 'super' ? 95 : 85;
    const { data: existingMatch } = await supabase
      .from('matchs')
      .select('id')
      .eq('candidat_id', candidat.id)
      .eq('offre_id', offre_id)
      .maybeSingle();

    const likedCandidateIds = offre.recruteurs?.matching?.meta?.liked_candidate_ids || [];
    const recruiterAlreadyLiked = includesId(likedCandidateIds, [candidat.id, candidat.user_id]);
    if (!existingMatch && !recruiterAlreadyLiked) {
      return res.json({
        match: false,
        candidature_sent: candidatureSent,
        swipes_u: usage.swipes_used,
        swipes_m: plan === 'freemium' ? FREE_SWIPES_MONTHLY : 999,
      });
    }

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
    res.json({
      match: true,
      candidature_sent: candidatureSent,
      questions: offre.recruteurs?.questions || [],
      swipes_u: usage.swipes_used,
      swipes_m: plan === 'freemium' ? FREE_SWIPES_MONTHLY : 999,
      ...match,
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

module.exports = router;
