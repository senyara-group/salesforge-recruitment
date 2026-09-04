const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureCandidateProfile, getUserEmail } = require('../utils/profiles');
const { trackBrevoEvent } = require('../utils/brevoEvents');
const { buildCandidateSnapshot } = require('../utils/applicationWorkflow');

const CV_BUCKET = process.env.CV_BUCKET || 'candidate-cvs';


function appendUnique(values = [], value) {
  return [...new Set([...values.map(String), String(value)])];
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function swipeUsage(candidat) {
  const month = currentMonthKey();
  const meta = candidat.swipes_meta || {};
  return meta.swipes_month === month ? Number(meta.swipes_used || 0) : 0;
}

async function markOfferSeenAndCount(candidat, offreId) {
  const meta = candidat.swipes_meta || {};
  const month = currentMonthKey();
  const currentUsed = meta.swipes_month === month ? Number(meta.swipes_used || 0) : 0;
  const likedOfferIds = meta.liked_offer_ids || [];
  const passedOfferIds = meta.passed_offer_ids || [];
  const nextMeta = {
    ...meta,
    swiped_offer_ids: appendUnique(meta.swiped_offer_ids || [], offreId),
    liked_offer_ids: likedOfferIds,
    passed_offer_ids: passedOfferIds,
    swipes_month: month,
    swipes_used: currentUsed + 1,
  };

  const { error } = await supabase
    .from('candidats')
    .update({ swipes_meta: nextMeta })
    .eq('id', candidat.id);

  if (error) throw error;
  return nextMeta;
}

async function markCandidateChoice(candidat, offreId, action) {
  const meta = candidat.swipes_meta || {};
  const nextMeta = {
    ...meta,
    swiped_offer_ids: appendUnique(meta.swiped_offer_ids || [], offreId),
    liked_offer_ids: action === 'pass'
      ? (meta.liked_offer_ids || []).map(String).filter((item) => item !== String(offreId))
      : appendUnique(meta.liked_offer_ids || [], offreId),
    passed_offer_ids: action === 'pass'
      ? appendUnique(meta.passed_offer_ids || [], offreId)
      : (meta.passed_offer_ids || []).map(String).filter((item) => item !== String(offreId)),
  };

  const { error } = await supabase
    .from('candidats')
    .update({ swipes_meta: nextMeta })
    .eq('id', candidat.id);

  if (error) throw error;
  return nextMeta;
}

function includesId(values = [], ids = []) {
  const set = new Set(values.filter(Boolean).map(String));
  return ids.filter(Boolean).some((id) => set.has(String(id)));
}

async function upsertCandidature(candidat, offreId, action) {
  const { data: existingCandidature } = await supabase
    .from('candidatures')
    .select('id')
    .eq('candidat_id', candidat.id)
    .eq('offre_id', offreId)
    .maybeSingle();

  if (existingCandidature) return { created: false, id: existingCandidature.id };

  const payload = {
    statut: 'envoyee',
    lettre_type: action === 'super' ? 'prioritaire' : 'candidate_like',
  };

  let snapshot;
  if (!existingCandidature) {
    const meta = candidat.axes?.meta || {};
    let cvSnapshotPath = '';
    if (meta.cv_path) {
      cvSnapshotPath = `${candidat.user_id}/applications/${offreId}-${Date.now()}-${meta.cv_file_name || 'cv'}`;
      const { error: copyError } = await supabase.storage.from(meta.cv_bucket || CV_BUCKET).copy(meta.cv_path, cvSnapshotPath);
      if (copyError) throw new Error('Impossible de figer le CV transmis avec cette candidature');
    }
    snapshot = buildCandidateSnapshot(candidat, { ...meta, cv_snapshot_path: cvSnapshotPath });
  }

  const candidatureQuery = supabase.from('candidatures').insert({
      candidat_id: candidat.id,
      offre_id: offreId,
      snapshot,
      ...payload,
    });

  const { data, error } = await candidatureQuery.select('id').single();
  if (error) throw error;
  return { created: true, id: data.id };
}

router.post('/', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const { offre_id, action } = req.body;

    if (!offre_id) return res.status(400).json({ error: 'offre_id requis' });
    if (!['like', 'super', 'pass'].includes(action)) {
      return res.status(400).json({ error: 'Action de swipe invalide' });
    }

    const { data: offre, error: offreError } = await supabase
      .from('offres')
      .select('id, titre, statut, auto_candidature, recruteurs(id, user_id, matching, questions)')
      .eq('id', offre_id)
      .maybeSingle();

    if (offreError) return res.status(400).json({ error: offreError });
    if (!offre) return res.status(404).json({ error: 'Offre introuvable' });
    if (offre.statut && offre.statut !== 'active') return res.status(409).json({ error: 'Cette offre n’accepte plus de candidatures' });

    const usage = await markOfferSeenAndCount(candidat, offre_id);
    await markCandidateChoice({ ...candidat, swipes_meta: usage }, offre_id, action);

    // Scénario 01, étape finale : sortie de la relance "vous n'avez pas encore swipé".
    // Déclenché sur toute action (like/super/pass) — c'est bien l'acte de swiper qui compte ici.
    getUserEmail(req.user.id).then((email) => {
      trackBrevoEvent(email, 'swipe_effectue', { action }).catch(() => {});
    }).catch(() => {});

    if (action === 'pass') return res.json({ match: false });

    const candidatureSent = true;
    const candidatureResult = candidatureSent ? await upsertCandidature(candidat, offre_id, action) : null;

    // Scénario 02, étape 5 : notifie le recruteur d'une nouvelle candidature.
    if (candidatureResult?.created && offre.recruteurs?.user_id) {
      getUserEmail(offre.recruteurs.user_id).then((recruiterEmail) => {
        trackBrevoEvent(recruiterEmail, 'candidature_recue', {
          poste: offre.titre,
          candidat: [candidat.prenom, candidat.nom].filter(Boolean).join(' ') || 'Un candidat',
          score: candidat.score_adn || 0,
          type_profil: candidat.axes?.resultat?.type || '',
        }).catch(() => {});
      }).catch(() => {});
    }

    const score = action === 'super' ? 95 : 85;

    // Source de vérité atomique (table dédiée, contrainte d'unicité) plutôt que le
    // tableau JSON matching.meta.liked_candidate_ids, sujet à des écritures concurrentes
    // qui pouvaient silencieusement perdre un like lors de swipes rapprochés.
    let recruiterAlreadyLiked = false;
    if (offre.recruteurs?.id) {
      const { data: likeRow } = await supabase
        .from('candidat_likes')
        .select('id')
        .eq('candidat_id', candidat.id)
        .eq('recruteur_id', offre.recruteurs.id)
        .maybeSingle();
      recruiterAlreadyLiked = Boolean(likeRow);
    }

    const { data: existingMatch } = await supabase
      .from('matchs')
      .select('id')
      .eq('candidat_id', candidat.id)
      .eq('offre_id', offre_id)
      .maybeSingle();

    if (!existingMatch && !recruiterAlreadyLiked) {
      return res.json({
        match: false,
        candidature_sent: candidatureSent,
        candidature_duplicate: !candidatureResult?.created,
        swipes_u: usage.swipes_used,
        swipes_m: 999,
      });
    }

    // Upsert atomique (contrainte d'unicité candidat_id+offre_id côté base) : si le
    // recruteur crée le même match au même instant depuis /recruteurs/swipe, les deux
    // requêtes convergent vers la même ligne au lieu que l'une échoue silencieusement.
    const { data: match, error: matchError } = await supabase
      .from('matchs')
      .upsert({
        candidat_id: candidat.id,
        offre_id,
        score_match: score,
        score_compat: score,
      }, { onConflict: 'candidat_id,offre_id' })
      .select('*')
      .single();

    if (matchError) return res.status(400).json({ error: matchError });
    res.json({
      match: true,
      candidature_sent: candidatureSent,
      candidature_duplicate: !candidatureResult?.created,
      questions: offre.recruteurs?.questions || [],
      swipes_u: usage.swipes_used,
      swipes_m: 999,
      ...match,
    });

    // Scénario 04-A : entrée dans le suivi "match sans conversation", des deux côtés.
    if (!existingMatch) {
      getUserEmail(req.user.id).then((candidatEmail) => {
        trackBrevoEvent(candidatEmail, 'match_cree', { entreprise: '', match_id: match.id }).catch(() => {});
      }).catch(() => {});
      if (offre.recruteurs?.user_id) {
        getUserEmail(offre.recruteurs.user_id).then((recruiterEmail) => {
          trackBrevoEvent(recruiterEmail, 'match_cree', {
            candidat: [candidat.prenom, candidat.nom].filter(Boolean).join(' ') || 'Un candidat',
            match_id: match.id,
          }).catch(() => {});
        }).catch(() => {});
      }
    }
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

module.exports = router;
