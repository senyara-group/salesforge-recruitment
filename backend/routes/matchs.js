const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureCandidateProfile } = require('../utils/profiles');

function initials(text = '') {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'SF';
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const [matchs, messages] = await Promise.all([
      supabase
        .from('matchs')
        .select('id, score_match, score_compat, created_at, offres(id, titre, type, lieu, recruteurs(entreprise))')
        .eq('candidat_id', candidat.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('messages')
        .select('match_id')
        .or(`sender_id.eq.${req.user.id},receiver_id.eq.${req.user.id}`)
        .not('match_id', 'is', null),
    ]);

    if (matchs.error) return res.status(400).json({ error: matchs.error });
    if (messages.error) return res.status(400).json({ error: messages.error });

    const discussedMatchIds = new Set((messages.data || []).map((message) => message.match_id));
    res.json((matchs.data || []).map((match) => {
      const offre = match.offres || {};
      const entreprise = offre.recruteurs?.entreprise || 'Entreprise';
      const inDiscussion = discussedMatchIds.has(match.id);
      const details = [entreprise, offre.type, offre.lieu].filter(Boolean).join(' - ');

      return {
        id: match.id,
        co: initials(entreprise),
        bg: '#1340E0',
        t: offre.titre || 'Offre',
        s: details,
        st: inDiscussion ? 'discussion' : 'new',
        sl: inDiscussion ? 'En discussion' : 'Nouveau',
        score: match.score_match || match.score_compat || 0,
      };
    }));
  } catch (error) {
    res.status(400).json({ error });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const { data, error } = await supabase
      .from('matchs')
      .select('*')
      .eq('id', req.params.id)
      .eq('candidat_id', candidat.id)
      .single();

    if (error) return res.status(400).json({ error });
    res.json(data);
  } catch (error) {
    res.status(400).json({ error });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const { offre_id, score_match, score_compat, score } = req.body;

    const { data: existingMatch } = await supabase
      .from('matchs')
      .select('id')
      .eq('candidat_id', candidat.id)
      .eq('offre_id', offre_id)
      .maybeSingle();

    const matchQuery = existingMatch
      ? supabase
        .from('matchs')
        .update({ score_match: score_match ?? score, score_compat })
        .eq('id', existingMatch.id)
      : supabase
        .from('matchs')
        .insert({
          candidat_id: candidat.id,
          offre_id,
          score_match: score_match ?? score,
          score_compat,
        });

    const { data, error } = await matchQuery
      .select('*')
      .single();

    if (error) return res.status(400).json({ error });
    res.json(data);
  } catch (error) {
    res.status(400).json({ error });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const { error } = await supabase
      .from('matchs')
      .delete()
      .eq('id', req.params.id)
      .eq('candidat_id', candidat.id);

    if (error) return res.status(400).json({ error });
    res.json({ message: 'Match supprime' });
  } catch (error) {
    res.status(400).json({ error });
  }
});

module.exports = router;
