const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureRecruiterProfile } = require('../utils/profiles');

function definedOnly(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

function publicError(res, error) {
  return res.status(error.status || 400).json({ error: error.message || error });
}

function appendUnique(values = [], value) {
  return [...new Set([...values.map(String), String(value)])];
}

function removeValue(values = [], value) {
  return values.map(String).filter((item) => item !== String(value));
}

function firstIntersection(left = [], right = []) {
  const rightSet = new Set(right.map(String));
  return left.find((item) => rightSet.has(String(item)));
}

function mergeMatching(currentMatching = {}, matching, extraMeta = {}) {
  return {
    ...(currentMatching || {}),
    ...(matching || {}),
    meta: {
      ...(currentMatching?.meta || {}),
      ...extraMeta,
    },
  };
}

async function upsertCandidature(candidatId, offreId, action, source = 'recruteur_like') {
  const { data: existingCandidature } = await supabase
    .from('candidatures')
    .select('id, statut, lettre_type')
    .eq('candidat_id', candidatId)
    .eq('offre_id', offreId)
    .maybeSingle();

  const payload = {
    statut: existingCandidature?.lettre_type && existingCandidature.lettre_type !== 'recruteur_like'
      ? existingCandidature.statut || 'envoyee'
      : 'nouveau',
    lettre_type: existingCandidature?.lettre_type && existingCandidature.lettre_type !== 'recruteur_like'
      ? existingCandidature.lettre_type
      : source,
  };

  const query = existingCandidature
    ? supabase.from('candidatures').update(payload).eq('id', existingCandidature.id)
    : supabase.from('candidatures').insert({
      candidat_id: candidatId,
      offre_id: offreId,
      ...payload,
    });

  const { error } = await query;
  if (error) throw error;
}

function normalizeCandidate(candidature) {
  const candidat = candidature.candidats || {};
  const axes = candidat.axes?.resultat?.axes || candidat.axes || {};
  const axisEntries = Array.isArray(axes)
    ? axes
    : Object.entries(axes).filter(([, value]) => typeof value === 'number').map(([l, v]) => ({ l, v }));
  const shortName = candidat.nom ? `${candidat.nom.slice(0, 1)}.` : '';
  const name = [candidat.prenom, shortName].filter(Boolean).join(' ') || 'Candidat';

  return {
    id: candidature.id,
    candidat_id: candidat.id,
    av: `${candidat.prenom?.[0] || ''}${candidat.nom?.[0] || ''}`.toUpperCase() || 'SF',
    bg: '#1340E0',
    name,
    role: candidat.titre || 'Commercial',
    score: candidature.score_match || candidat.score_adn || 0,
    tags: axisEntries.slice(0, 3).map((axis) => axis.l),
  };
}

router.get('/profil', authMiddleware, async (req, res) => {
  try {
    const profil = await ensureRecruiterProfile(req.user.id);
    res.json(profil);
  } catch (error) {
    publicError(res, error);
  }
});

router.put('/profil', authMiddleware, async (req, res) => {
  try {
    const current = await ensureRecruiterProfile(req.user.id);

    const { entreprise, secteur, plan, questions, matching } = req.body;
    const nextMatching = matching === undefined
      ? current.matching
      : mergeMatching(current.matching, matching);

    const { data, error } = await supabase
      .from('recruteurs')
      .update(definedOnly({
        entreprise,
        secteur,
        plan,
        questions,
        matching: nextMatching,
      }))
      .eq('user_id', req.user.id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ error });
    res.json(data);
  } catch (error) {
    publicError(res, error);
  }
});

router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { data: offres, error: offresError } = await supabase
      .from('offres')
      .select('id, statut')
      .eq('recruteur_id', recruteur.id);

    if (offresError) return res.status(400).json({ error: offresError });
    const offreIds = offres.map((offre) => offre.id);

    const { data: candidatures, error: candidaturesError } = offreIds.length
      ? await supabase.from('candidatures').select('id, statut, created_at').in('offre_id', offreIds)
      : { data: [], error: null };

    if (candidaturesError) return res.status(400).json({ error: candidaturesError });

    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    res.json({
      recues: candidatures.length,
      recues_new: candidatures.filter((c) => new Date(c.created_at).getTime() >= since).length,
      chauds: candidatures.filter((c) => c.statut === 'repondu' || c.statut === 'entretien').length,
      pipeline: candidatures.filter((c) => c.statut && c.statut !== 'envoyee').length,
      offres: offres.length,
      plan_label: `Plan ${recruteur.plan || 'starter'} · ${offres.length} offres actives`,
    });
  } catch (error) {
    publicError(res, error);
  }
});

router.get('/questions', authMiddleware, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    res.json({ questions: recruteur.questions || [] });
  } catch (error) {
    publicError(res, error);
  }
});

router.post('/matching-count', authMiddleware, async (req, res) => {
  try {
    const { matching = {} } = req.body;
    const { data, error } = await supabase.from('candidats').select('axes');
    if (error) return res.status(400).json({ error });

    const count = data.filter((candidate) => {
      const axes = candidate.axes?.resultat?.axes || candidate.axes || {};
      const entries = Array.isArray(axes) ? axes : Object.entries(axes).map(([l, v]) => ({ l, v }));
      const score = Object.entries(matching).reduce((sum, [key, weight]) => {
        const axis = entries.find((item) => item.l?.toLowerCase().includes(key.toLowerCase()));
        return sum + Number(axis?.v || 50) * Number(weight || 0);
      }, 0);
      const weights = Object.values(matching).reduce((sum, weight) => sum + Number(weight || 0), 0);
      return weights ? Math.round(score / weights) >= 70 : true;
    }).length;

    res.json({ count });
  } catch (error) {
    publicError(res, error);
  }
});

router.get('/pipeline', authMiddleware, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { data: offres, error: offresError } = await supabase
      .from('offres')
      .select('id')
      .eq('recruteur_id', recruteur.id);
    if (offresError) return res.status(400).json({ error: offresError });

    const offreIds = offres.map((offre) => offre.id);
    const { data, error } = offreIds.length
      ? await supabase
        .from('candidatures')
        .select('id, statut, candidats(id, nom, prenom, titre, score_adn, axes)')
        .in('offre_id', offreIds)
      : { data: [], error: null };
    if (error) return res.status(400).json({ error });

    const pipeline = { nouveau: [], contacte: [], entretien: [], offre: [] };
    data.forEach((candidature) => {
      const key = pipeline[candidature.statut] ? candidature.statut : 'nouveau';
      pipeline[key].push(normalizeCandidate(candidature));
    });
    res.json(pipeline);
  } catch (error) {
    publicError(res, error);
  }
});

router.put('/pipeline/move', authMiddleware, async (req, res) => {
  try {
    const { candidature_id, to } = req.body;
    const { data, error } = await supabase
      .from('candidatures')
      .update({ statut: to })
      .eq('id', candidature_id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ error });
    res.json(data);
  } catch (error) {
    publicError(res, error);
  }
});

router.post('/swipe', authMiddleware, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { candidat_id, action } = req.body;
    if (!candidat_id) return res.status(400).json({ error: 'candidat_id requis' });
    if (!['like', 'super', 'pass'].includes(action)) {
      return res.status(400).json({ error: 'Action de swipe invalide' });
    }

    const meta = recruteur.matching?.meta || {};
    const swipedCandidateIds = appendUnique(meta.swiped_candidate_ids || [], candidat_id);
    const likedCandidateIds = action === 'pass'
      ? removeValue(meta.liked_candidate_ids || [], candidat_id)
      : appendUnique(meta.liked_candidate_ids || [], candidat_id);
    const passedCandidateIds = action === 'pass'
      ? appendUnique(meta.passed_candidate_ids || [], candidat_id)
      : removeValue(meta.passed_candidate_ids || [], candidat_id);
    const { error: seenError } = await supabase
      .from('recruteurs')
      .update({
        matching: mergeMatching(recruteur.matching, undefined, {
          swiped_candidate_ids: swipedCandidateIds,
          liked_candidate_ids: likedCandidateIds,
          passed_candidate_ids: passedCandidateIds,
        }),
      })
      .eq('id', recruteur.id);
    if (seenError) console.warn('Swipe vu non persiste:', seenError.message || seenError);

    if (action === 'pass') return res.json({ match: false });

    const score = action === 'super' ? 95 : 85;
    const { data: offres } = await supabase
      .from('offres')
      .select('id')
      .eq('recruteur_id', recruteur.id);
    const offreIds = (offres || []).map((row) => row.id);
    if (!offreIds.length) return res.status(400).json({ error: 'Publiez une offre avant de matcher un candidat' });

    const { data: candidat, error: candidatError } = await supabase
      .from('candidats')
      .select('id, swipes_meta')
      .eq('id', candidat_id)
      .maybeSingle();
    if (candidatError) return res.status(400).json({ error: candidatError });
    if (!candidat) return res.status(404).json({ error: 'Candidat introuvable' });

    const candidateLikedOfferId = firstIntersection(candidat.swipes_meta?.liked_offer_ids || [], offreIds);
    const targetOfferId = candidateLikedOfferId || offreIds[0];
    await upsertCandidature(candidat_id, targetOfferId, action);

    const { data: existingMatches, error: existingError } = offreIds.length
      ? await supabase
        .from('matchs')
        .select('id, created_at')
        .eq('candidat_id', candidat_id)
        .in('offre_id', offreIds)
        .order('created_at', { ascending: false })
      : { data: [], error: null };
    if (existingError) return res.status(400).json({ error: existingError });

    const existingMatch = existingMatches?.[0];
    if (!existingMatch && !candidateLikedOfferId) {
      return res.json({ match: false, candidature_sent: true });
    }

    const matchQuery = existingMatch
      ? supabase.from('matchs').update({ score_match: score, score_compat: score }).eq('id', existingMatch.id)
      : supabase.from('matchs').insert({
        candidat_id,
        offre_id: candidateLikedOfferId,
        score_match: score,
        score_compat: score,
      });

    const { data: match, error } = await matchQuery
      .select('*')
      .single();

    if (error) return res.status(400).json({ error });
    res.json({ match: true, ...match });
  } catch (error) {
    publicError(res, error);
  }
});

module.exports = router;
