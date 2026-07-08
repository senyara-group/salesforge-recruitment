const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureCandidateProfile, ensureRecruiterProfile } = require('../utils/profiles');

function initials(text = '') {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'SF';
}

function formatTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString('fr-FR');
}

async function getUserRole(userId) {
  const { data } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .maybeSingle();

  return data?.role || 'candidat';
}

async function getLatestMessages(userId) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

function latestByMatch(messages) {
  return messages.reduce((acc, message) => {
    if (message.match_id && !acc[message.match_id]) acc[message.match_id] = message;
    return acc;
  }, {});
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

function latestForMatchIds(messages, matchIds = []) {
  const ids = new Set(matchIds.map(String));
  return messages.find((message) => ids.has(String(message.match_id)));
}

async function getMatchParticipants(matchId) {
  const { data, error } = await supabase
    .from('matchs')
    .select('id, candidat_id, offre_id, candidats(user_id), offres(id, recruteur_id, recruteurs(user_id))')
    .eq('id', matchId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const { data: recruiterOffers, error: offersError } = await supabase
    .from('offres')
    .select('id')
    .eq('recruteur_id', data.offres?.recruteur_id);
  if (offersError) throw offersError;

  const offerIds = (recruiterOffers || []).map((offre) => offre.id);
  const { data: pairMatches, error: pairError } = offerIds.length
    ? await supabase
      .from('matchs')
      .select('id, created_at')
      .eq('candidat_id', data.candidat_id)
      .in('offre_id', offerIds)
      .order('created_at', { ascending: false })
    : { data: [], error: null };
  if (pairError) throw pairError;

  const matchIds = (pairMatches || []).map((match) => match.id);

  return {
    candidateId: data.candidat_id,
    recruiterId: data.offres?.recruteur_id,
    candidateUserId: data.candidats?.user_id,
    recruiterUserId: data.offres?.recruteurs?.user_id,
    matchIds: matchIds.length ? matchIds : [data.id],
    canonicalMatchId: matchIds[0] || data.id,
  };
}

async function ensureMatchAccess(matchId, userId) {
  if (!matchId) return null;
  const participants = await getMatchParticipants(matchId);
  if (!participants) {
    const error = new Error('Match introuvable');
    error.status = 404;
    throw error;
  }

  const allowed = [participants.candidateUserId, participants.recruiterUserId]
    .map(String)
    .includes(String(userId));
  if (!allowed) {
    const error = new Error('Conversation non autorisee');
    error.status = 403;
    throw error;
  }

  return participants;
}

router.get('/threads', authMiddleware, async (req, res) => {
  try {
    const role = await getUserRole(req.user.id);
    const messages = await getLatestMessages(req.user.id);
    const byMatch = latestByMatch(messages);
    let threads = [];
    let coveredMatchIds = new Set();

    if (role === 'recruteur') {
      const recruteur = await ensureRecruiterProfile(req.user.id);
      const { data: offres, error: offresError } = await supabase
        .from('offres')
        .select('id')
        .eq('recruteur_id', recruteur.id);
      if (offresError) return res.status(400).json({ error: offresError });

      const offreIds = offres.map((offre) => offre.id);
      const { data: matchs, error: matchsError } = offreIds.length
        ? await supabase
          .from('matchs')
          .select('id, created_at, candidats(id, user_id, prenom, nom, titre), offres(titre)')
          .in('offre_id', offreIds)
          .order('created_at', { ascending: false })
        : { data: [], error: null };
      if (matchsError) return res.status(400).json({ error: matchsError });
      coveredMatchIds = new Set(matchs.map((match) => match.id));

      threads = dedupeBy(matchs, (match) => match.candidats?.id).map((match) => {
        const candidat = match.candidats || {};
        const matchIds = matchs
          .filter((item) => String(item.candidats?.id) === String(candidat.id))
          .map((item) => item.id);
        const latest = latestForMatchIds(messages, matchIds) || byMatch[match.id];
        const name = [candidat.prenom, candidat.nom ? `${candidat.nom.slice(0, 1)}.` : ''].filter(Boolean).join(' ') || 'Candidat';
        const mine = latest?.sender_id === req.user.id;
        return {
          id: match.id,
          match_id: match.id,
          match_ids: matchIds,
          receiver_id: candidat.user_id,
          av: initials(name),
          bg: '#1340E0',
          nom: name,
          time: formatTime(latest?.created_at || match.created_at),
          prev: latest ? `${mine ? 'Vous : ' : ''}${latest.contenu || ''}` : `Match sur ${match.offres?.titre || 'votre offre'}`,
          ur: Boolean(latest && !mine && !latest.lu),
          mine,
          read: latest ? Boolean(latest.lu) : null,
          status: latest ? (mine ? (latest.lu ? 'Lu' : 'Envoye') : (!latest.lu ? 'Non lu' : 'Lu')) : '',
        };
      });
    } else {
      const candidat = await ensureCandidateProfile(req.user.id);
      const { data: matchs, error: matchsError } = await supabase
        .from('matchs')
        .select('id, created_at, offres(titre, recruteurs(user_id, entreprise))')
        .eq('candidat_id', candidat.id)
        .order('created_at', { ascending: false });
      if (matchsError) return res.status(400).json({ error: matchsError });
      coveredMatchIds = new Set(matchs.map((match) => match.id));

      threads = dedupeBy(matchs, (match) => match.offres?.recruteurs?.user_id).map((match) => {
        const recruteur = match.offres?.recruteurs || {};
        const matchIds = matchs
          .filter((item) => String(item.offres?.recruteurs?.user_id) === String(recruteur.user_id))
          .map((item) => item.id);
        const latest = latestForMatchIds(messages, matchIds) || byMatch[match.id];
        const mine = latest?.sender_id === req.user.id;
        const name = recruteur.entreprise || 'Recruteur';
        return {
          id: match.id,
          match_id: match.id,
          match_ids: matchIds,
          receiver_id: recruteur.user_id,
          av: initials(name),
          bg: '#1340E0',
          nom: name,
          time: formatTime(latest?.created_at || match.created_at),
          prev: latest ? `${mine ? 'Vous : ' : ''}${latest.contenu || ''}` : `Match sur ${match.offres?.titre || 'une offre'}`,
          ur: Boolean(latest && !mine && !latest.lu),
          mine,
          read: latest ? Boolean(latest.lu) : null,
          status: latest ? (mine ? (latest.lu ? 'Lu' : 'Envoye') : (!latest.lu ? 'Non lu' : 'Lu')) : '',
        };
      });
    }

    res.json(threads);
  } catch (error) {
    res.status(400).json({ error: error.message || error });
  }
});

router.get('/thread/:matchId', authMiddleware, async (req, res) => {
  try {
    const participants = await ensureMatchAccess(req.params.matchId, req.user.id);

    const query = supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: true });
    const { data, error } = participants.matchIds.length > 1
      ? await query.in('match_id', participants.matchIds)
      : await query.eq('match_id', participants.matchIds[0]);

    if (error) return res.status(400).json({ error });

    const readQuery = supabase
      .from('messages')
      .update({ lu: true })
      .eq('receiver_id', req.user.id)
      .eq('lu', false);
    if (participants.matchIds.length > 1) await readQuery.in('match_id', participants.matchIds);
    else await readQuery.eq('match_id', participants.matchIds[0]);

    res.json(data || []);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

router.post('/send', authMiddleware, async (req, res) => {
  try {
    const { receiver_id, destinataire_id, match_id, contenu, texte } = req.body;
    const receiverId = receiver_id || destinataire_id;
    const body = contenu || texte;

    if (!receiverId) return res.status(400).json({ error: 'Destinataire manquant' });
    if (!match_id) return res.status(400).json({ error: 'Match requis pour envoyer un message' });
    if (!body || !body.trim()) return res.status(400).json({ error: 'Message vide' });

    const participants = await ensureMatchAccess(match_id, req.user.id);
    let storedMatchId = match_id;
    if (participants) {
      const expectedReceiver = String(participants.candidateUserId) === String(req.user.id)
        ? participants.recruiterUserId
        : participants.candidateUserId;

      if (String(receiverId) !== String(expectedReceiver)) {
        return res.status(403).json({ error: 'Destinataire invalide pour ce match' });
      }
      storedMatchId = participants.canonicalMatchId;
    }

    const { data, error } = await supabase
      .from('messages')
      .insert({
        sender_id: req.user.id,
        receiver_id: receiverId,
        match_id: storedMatchId,
        contenu: body.trim(),
        lu: false,
      })
      .select('*')
      .single();

    if (error) return res.status(400).json({ error });
    res.json(data);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

module.exports = router;
