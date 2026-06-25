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

async function getMatchParticipants(matchId) {
  const { data, error } = await supabase
    .from('matchs')
    .select('id, candidats(user_id), offres(recruteurs(user_id))')
    .eq('id', matchId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    candidateUserId: data.candidats?.user_id,
    recruiterUserId: data.offres?.recruteurs?.user_id,
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

  const allowed = [participants.candidateUserId, participants.recruiterUserId].includes(userId);
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
        const latest = byMatch[match.id];
        const name = [candidat.prenom, candidat.nom ? `${candidat.nom.slice(0, 1)}.` : ''].filter(Boolean).join(' ') || 'Candidat';
        const mine = latest?.sender_id === req.user.id;
        return {
          id: match.id,
          match_id: match.id,
          receiver_id: candidat.user_id,
          av: initials(name),
          bg: '#1340E0',
          nom: name,
          time: formatTime(latest?.created_at || match.created_at),
          prev: latest ? `${mine ? 'Vous : ' : ''}${latest.contenu || ''}` : `Match sur ${match.offres?.titre || 'votre offre'}`,
          ur: Boolean(latest && !mine && !latest.lu),
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

      threads = matchs.map((match) => {
        const recruteur = match.offres?.recruteurs || {};
        const latest = byMatch[match.id];
        const mine = latest?.sender_id === req.user.id;
        const name = recruteur.entreprise || 'Recruteur';
        return {
          id: match.id,
          match_id: match.id,
          receiver_id: recruteur.user_id,
          av: initials(name),
          bg: '#1340E0',
          nom: name,
          time: formatTime(latest?.created_at || match.created_at),
          prev: latest ? `${mine ? 'Vous : ' : ''}${latest.contenu || ''}` : `Match sur ${match.offres?.titre || 'une offre'}`,
          ur: Boolean(latest && !mine && !latest.lu),
        };
      });
    }

    const orphanThreads = messages
      .filter((message) => !message.match_id || !coveredMatchIds.has(message.match_id))
      .map((message) => {
        const mine = message.sender_id === req.user.id;
        const receiverId = mine ? message.receiver_id : message.sender_id;
        return {
          id: message.match_id || message.id,
          match_id: message.match_id,
          receiver_id: receiverId,
          av: initials(mine ? 'Vous' : 'Conversation'),
          bg: '#1340E0',
          nom: mine ? 'Conversation' : 'Nouveau message',
          time: formatTime(message.created_at),
          prev: `${mine ? 'Vous : ' : ''}${message.contenu || ''}`,
          ur: !mine && !message.lu,
        };
      });

    res.json([...threads, ...orphanThreads]);
  } catch (error) {
    res.status(400).json({ error: error.message || error });
  }
});

router.get('/thread/:matchId', authMiddleware, async (req, res) => {
  try {
    await ensureMatchAccess(req.params.matchId, req.user.id);

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('match_id', req.params.matchId)
      .order('created_at', { ascending: true });

    if (error) return res.status(400).json({ error });

    await supabase
      .from('messages')
      .update({ lu: true })
      .eq('match_id', req.params.matchId)
      .eq('receiver_id', req.user.id)
      .eq('lu', false);

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
    if (!body || !body.trim()) return res.status(400).json({ error: 'Message vide' });

    const participants = await ensureMatchAccess(match_id, req.user.id);
    if (participants) {
      const expectedReceiver = participants.candidateUserId === req.user.id
        ? participants.recruiterUserId
        : participants.candidateUserId;

      if (String(receiverId) !== String(expectedReceiver)) {
        return res.status(403).json({ error: 'Destinataire invalide pour ce match' });
      }
    }

    const { data, error } = await supabase
      .from('messages')
      .insert({
        sender_id: req.user.id,
        receiver_id: receiverId,
        match_id,
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
