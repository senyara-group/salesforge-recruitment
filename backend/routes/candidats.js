const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureCandidateProfile, ensureRecruiterProfile } = require('../utils/profiles');

function definedOnly(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

function normalizeAxes(axes) {
  if (!axes || typeof axes !== 'object') return {};
  if (axes.resultat?.axes) {
    return Object.fromEntries(axes.resultat.axes.map((axis) => [axis.l, axis.v]));
  }
  return axes;
}

function compatibilityScore(candidateAxes = {}, matching = {}) {
  const entries = Object.entries(matching);
  if (!entries.length) return Number(candidateAxes.score || candidateAxes.Closing || 70);

  let total = 0;
  let weightTotal = 0;
  for (const [key, weight] of entries) {
    const normalizedKey = key.toLowerCase();
    const found = Object.entries(candidateAxes).find(([axis]) =>
      axis.toLowerCase().includes(normalizedKey) ||
      normalizedKey.includes(axis.toLowerCase())
    );
    total += Number(found?.[1] ?? 50) * Number(weight || 0);
    weightTotal += Number(weight || 0);
  }
  return weightTotal ? Math.round(total / weightTotal) : 0;
}

function uniqueValues(values = []) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function dedupeBy(items, keyGetter) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyGetter(item);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function recruiterSeenCandidateIds(userId) {
  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .maybeSingle();

  if (userRow?.role !== 'recruteur') return [];

  const recruteur = await ensureRecruiterProfile(userId);
  const { data: offres, error: offresError } = await supabase
    .from('offres')
    .select('id')
    .eq('recruteur_id', recruteur.id);

  if (offresError) throw offresError;
  const offreIds = (offres || []).map((offre) => offre.id);

  const { data: matchs, error: matchsError } = offreIds.length
    ? await supabase.from('matchs').select('candidat_id').in('offre_id', offreIds)
    : { data: [], error: null };

  if (matchsError) throw matchsError;

  const matchedCandidateIds = uniqueValues((matchs || []).map((match) => match.candidat_id));
  const { data: matchedCandidates, error: matchedCandidatesError } = matchedCandidateIds.length
    ? await supabase.from('candidats').select('id, user_id').in('id', matchedCandidateIds)
    : { data: [], error: null };
  if (matchedCandidatesError) throw matchedCandidatesError;

  return uniqueValues([
    ...(recruteur.matching?.meta?.swiped_candidate_ids || []),
    ...(matchs || []).map((match) => match.candidat_id),
    ...(matchedCandidates || []).map((candidate) => candidate.user_id),
  ]);
}

router.get('/profil', authMiddleware, async (req, res) => {
  try {
    const profil = await ensureCandidateProfile(req.user.id);
    res.json(profil);
  } catch (error) {
    res.status(400).json({ error });
  }
});

router.put('/profil', authMiddleware, async (req, res) => {
  try {
    await ensureCandidateProfile(req.user.id);

    const current = await ensureCandidateProfile(req.user.id);
    const { nom, prenom, titre, score_adn, axes, cv_url, motivation, anonyme } = req.body;
    const nextAxes = axes === undefined
      ? current.axes
      : {
        ...(current.axes || {}),
        ...(axes || {}),
      };
    if (motivation !== undefined || anonyme !== undefined) {
      nextAxes.meta = {
        ...(current.axes?.meta || {}),
        ...(motivation !== undefined ? { motivation } : {}),
        ...(anonyme !== undefined ? { anonyme } : {}),
      };
    }

    const { data, error } = await supabase
      .from('candidats')
      .update(definedOnly({ nom, prenom, titre, score_adn, axes: nextAxes, cv_url }))
      .eq('user_id', req.user.id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ error });
    res.json(data);
  } catch (error) {
    res.status(400).json({ error });
  }
});

router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);

    const [matchs, candidatures] = await Promise.all([
      supabase.from('matchs').select('id, created_at').eq('candidat_id', candidat.id),
      supabase.from('candidatures').select('id, statut, lettre_type').eq('candidat_id', candidat.id),
    ]);

    if (matchs.error) return res.status(400).json({ error: matchs.error });
    if (candidatures.error) return res.status(400).json({ error: candidatures.error });

    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    res.json({
      matchs: matchs.data.length,
      matchs_new: matchs.data.filter((m) => new Date(m.created_at).getTime() >= since).length,
      candidatures: candidatures.data.length,
      cands_auto: candidatures.data.filter((c) => c.lettre_type === 'auto').length,
      streak: candidat.axes?.meta?.streak || 0,
      salary: candidat.axes?.meta?.salary || '-',
    });
  } catch (error) {
    res.status(400).json({ error });
  }
});

router.get('/deck', authMiddleware, async (req, res) => {
  try {
    const matching = req.query.matching ? JSON.parse(req.query.matching) : {};
    const seenCandidateIds = await recruiterSeenCandidateIds(req.user.id);
    const { data, error } = await supabase
      .from('candidats')
      .select('*')
      .order('score_adn', { ascending: false, nullsFirst: false });

    if (error) return res.status(400).json({ error });

    const deck = dedupeBy(data, (candidat) => candidat.user_id || candidat.id)
      .filter((candidat) => candidat.user_id !== req.user.id)
      .filter((candidat) => !seenCandidateIds.includes(String(candidat.id)))
      .filter((candidat) => !seenCandidateIds.includes(String(candidat.user_id)))
      .map((candidat) => {
        const axes = normalizeAxes(candidat.axes);
        const anon = candidat.axes?.meta?.anonyme === true;
        const shortName = candidat.nom ? `${candidat.nom.slice(0, 1)}.` : '';
        const name = anon
          ? 'Candidat anonyme'
          : [candidat.prenom, shortName].filter(Boolean).join(' ') || 'Candidat';
        const initials = anon
          ? '?'
          : `${candidat.prenom?.[0] || ''}${candidat.nom?.[0] || ''}`.toUpperCase() || 'SF';
        const skills = Object.keys(axes).filter((key) => typeof axes[key] === 'number').slice(0, 5);

        return {
          id: candidat.id,
          user_id: candidat.user_id,
          name,
          initiales: initials,
          role: candidat.titre || 'Commercial',
          anon,
          m: compatibilityScore(axes, matching),
          adn_score: candidat.score_adn || 0,
          adn_type: candidat.axes?.resultat?.type || candidat.axes?.resultat?.type_profil || 'Profil commercial',
          rank: candidat.axes?.resultat?.rank || 'Profil verifie',
          axes: Object.entries(axes)
            .filter(([, value]) => typeof value === 'number')
            .slice(0, 6)
            .map(([l, v]) => ({ l, v })),
          pitch_score: candidat.axes?.resultat?.pitch_score || candidat.score_adn || 0,
          pitch_text: candidat.axes?.resultat?.desc || candidat.axes?.meta?.motivation || 'Profil candidat synchronise avec la base.',
          letter_text: candidat.axes?.meta?.motivation || candidat.titre || 'Lettre de motivation non renseignee.',
          letter_audio: Boolean(candidat.axes?.meta?.audio_url),
          letter_video: Boolean(candidat.axes?.meta?.video_url),
          skills: skills.length ? skills : ['Sales', 'B2B'],
          ai: candidat.axes?.resultat?.desc || 'Analyse basee sur le score ADN et les axes renseignes.',
          predict: [
            { v: `${compatibilityScore(axes, matching)}%`, l: 'Fit poste' },
            { v: candidat.score_adn || 0, l: 'ADN' },
            { v: 'Base', l: 'Source' },
          ],
        };
      });

    res.json(deck);
  } catch (error) {
    res.status(400).json({ error: error.message || error });
  }
});

module.exports = router;
