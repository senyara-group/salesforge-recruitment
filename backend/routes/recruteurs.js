const express = require('express');
const router = express.Router();
const path = require('path');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureRecruiterProfile } = require('../utils/profiles');
const requireRecruiterPlan = require('../middleware/requireRecruiterPlan');

const AVATAR_BUCKET = process.env.AVATAR_BUCKET || 'profile-photos';
const MAX_AVATAR_BYTES = Number(process.env.MAX_AVATAR_UPLOAD_MB || 3) * 1024 * 1024;
const AVATAR_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function definedOnly(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

function publicError(res, error) {
  return res.status(error.status || 400).json({ error: error.message || error });
}

function appendUnique(values = [], value) {
  return [...new Set([...values.map(String), String(value)])];
}

function sanitizeFilename(filename = 'photo.jpg') {
  const clean = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '-');
  return clean || 'photo.jpg';
}

function parseContentDisposition(header = '') {
  return header.split(';').slice(1).reduce((params, part) => {
    const [key, ...valueParts] = part.trim().split('=');
    if (!key || !valueParts.length) return params;
    let value = valueParts.join('=').trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    params[key.toLowerCase()] = value;
    return params;
  }, {});
}

function readRequestBuffer(req, maxBytes, label = 'Fichier') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error(`${label} trop volumineux`);
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function getMultipartFile(req, fieldName, maxBytes, label = 'Fichier') {
  const contentType = req.headers['content-type'] || '';
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1]
    || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];

  if (!boundary) {
    const error = new Error('Formulaire multipart invalide');
    error.status = 400;
    throw error;
  }

  const body = await readRequestBuffer(req, maxBytes, label);
  const parts = body.toString('latin1').split(`--${boundary}`);

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const rawHeaders = part.slice(0, headerEnd);
    const content = part.slice(headerEnd + 4).replace(/\r\n$/, '');
    const headers = Object.fromEntries(rawHeaders
      .split('\r\n')
      .filter(Boolean)
      .map((line) => {
        const [key, ...value] = line.split(':');
        return [key.toLowerCase(), value.join(':').trim()];
      }));

    const disposition = parseContentDisposition(headers['content-disposition']);
    if (disposition.name !== fieldName || !disposition.filename) continue;

    return {
      filename: sanitizeFilename(disposition.filename),
      contentType: headers['content-type'] || 'application/octet-stream',
      buffer: Buffer.from(content, 'latin1'),
    };
  }

  const error = new Error(`Fichier ${fieldName} manquant`);
  error.status = 400;
  throw error;
}

function validateAvatarFile(file) {
  const ext = path.extname(file.filename).toLowerCase();
  const type = String(file.contentType || '').toLowerCase();
  if (!AVATAR_EXTENSIONS.has(ext) || !AVATAR_MIME_TYPES.has(type)) {
    const error = new Error('Format photo non supporte. Utilisez JPG, PNG, WEBP ou GIF.');
    error.status = 400;
    throw error;
  }
  if (!file.buffer.length) {
    const error = new Error('Photo vide');
    error.status = 400;
    throw error;
  }
}

async function ensureAvatarBucket() {
  const existing = await supabase.storage.getBucket(AVATAR_BUCKET);
  if (!existing.error) return;

  const { error } = await supabase.storage.createBucket(AVATAR_BUCKET, {
    public: false,
    allowedMimeTypes: [...AVATAR_MIME_TYPES],
    fileSizeLimit: MAX_AVATAR_BYTES,
  });

  if (error && !/already|exist/i.test(error.message || '')) throw error;
}

async function removeStorageFile(bucket, storagePath) {
  if (!storagePath) return;
  const { error } = await supabase.storage.from(bucket).remove([storagePath]);
  if (error && !/not found|not exist|missing/i.test(error.message || '')) {
    console.warn('Suppression storage impossible:', error.message || error);
  }
}

async function withFreshRecruiterAvatarUrl(profile) {
  const avatarPath = profile?.avatar_meta?.avatar_path;
  const avatarBucket = profile?.avatar_meta?.avatar_bucket || AVATAR_BUCKET;
  if (!avatarPath) return { ...profile, avatar_url: '' };

  const { data, error } = await supabase.storage
    .from(avatarBucket)
    .createSignedUrl(avatarPath, 60 * 60 * 24);

  return { ...profile, avatar_url: !error && data?.signedUrl ? data.signedUrl : '' };
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

function normalizeCandidate(candidature, context = {}) {
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
    receiver_id: candidat.user_id,
    match_id: context.match?.id || null,
    match_ids: context.matchIds || [],
    discussed: Boolean(context.discussed),
    av: `${candidat.prenom?.[0] || ''}${candidat.nom?.[0] || ''}`.toUpperCase() || 'SF',
    bg: '#1340E0',
    name,
    role: candidat.titre || 'Commercial',
    score: context.match?.score_match || candidature.score_match || candidat.score_adn || 0,
    tags: axisEntries.slice(0, 3).map((axis) => axis.l),
  };
}

router.get('/profil', authMiddleware, requireRecruiterPlan, async (req, res) => {
  try {
    const profil = await ensureRecruiterProfile(req.user.id);
    res.json(profil);
  } catch (error) {
    publicError(res, error);
  }
});

router.post('/avatar', authMiddleware, async (req, res) => {
  try {
    const current = await ensureRecruiterProfile(req.user.id);
    const file = await getMultipartFile(req, 'avatar', MAX_AVATAR_BYTES, 'Photo');
    validateAvatarFile(file);
    await ensureAvatarBucket();

    const previousMeta = current.avatar_meta || {};
    const storagePath = `${req.user.id}/avatar-${Date.now()}-${file.filename}`;
    const { error: uploadError } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.contentType,
        upsert: false,
      });

    if (uploadError) throw uploadError;

    await removeStorageFile(previousMeta.avatar_bucket || AVATAR_BUCKET, previousMeta.avatar_path);

    const nextMeta = {
      ...previousMeta,
      avatar_bucket: AVATAR_BUCKET,
      avatar_path: storagePath,
      avatar_file_name: file.filename,
      avatar_uploaded_at: new Date().toISOString(),
    };

    const { data: signed } = await supabase.storage
      .from(AVATAR_BUCKET)
      .createSignedUrl(storagePath, 60 * 60 * 24);

    const { data, error } = await supabase
      .from('recruteurs')
      .update({ avatar_meta: nextMeta })
      .eq('user_id', req.user.id)
      .select('*')
      .single();

    if (error) throw error;
    res.json({ recruteur: data, avatar_url: signed?.signedUrl || '' });
  } catch (error) {
    publicError(res, error);
  }
});

router.delete('/avatar', authMiddleware, async (req, res) => {
  try {
    const current = await ensureRecruiterProfile(req.user.id);
    const meta = current.avatar_meta || {};
    await removeStorageFile(meta.avatar_bucket || AVATAR_BUCKET, meta.avatar_path);

    const { data, error } = await supabase
      .from('recruteurs')
      .update({ avatar_meta: {} })
      .eq('user_id', req.user.id)
      .select('*')
      .single();

    if (error) throw error;
    res.json({ recruteur: data });
  } catch (error) {
    publicError(res, error);
  }
});

router.put('/profil', authMiddleware, requireRecruiterPlan, async (req, res) => {
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

router.get('/stats', authMiddleware, requireRecruiterPlan , async (req, res) => {
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
    const PLAN_DISPLAY_NAMES = { solo: 'Entrepreneur / Indépendant', starter: 'Business', pro: 'Partenaire', enterprise: 'Enterprise' };
    const planName = PLAN_DISPLAY_NAMES[req.recruiterPlan] || req.recruiterPlan;
    const { avatar_url } = await withFreshRecruiterAvatarUrl(recruteur);
    res.json({
      recues: candidatures.length,
      recues_new: candidatures.filter((c) => new Date(c.created_at).getTime() >= since).length,
      chauds: candidatures.filter((c) => c.statut === 'repondu' || c.statut === 'entretien').length,
      pipeline: candidatures.length,
      offres: offres.length,
      plan_label: `Plan ${planName} · ${offres.length} offres actives`,
      entreprise: recruteur.entreprise || '',
      avatar_url,
    });
  } catch (error) {
    publicError(res, error);
  }
});

router.get('/questions', authMiddleware, requireRecruiterPlan, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    res.json({ questions: recruteur.questions || [] });
  } catch (error) {
    publicError(res, error);
  }
});

router.post('/matching-count', authMiddleware, requireRecruiterPlan, async (req, res) => {
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

router.get('/pipeline', authMiddleware, requireRecruiterPlan, async (req, res) => {
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
        .select('id, statut, candidat_id, offre_id, candidats(id, user_id, nom, prenom, titre, score_adn, axes)')
        .in('offre_id', offreIds)
      : { data: [], error: null };
    if (error) return res.status(400).json({ error });

    const candidatIds = [...new Set((data || []).map((row) => row.candidat_id).filter(Boolean))];
    const { data: matchs, error: matchsError } = offreIds.length && candidatIds.length
      ? await supabase
        .from('matchs')
        .select('id, candidat_id, offre_id, score_match, score_compat, created_at')
        .in('offre_id', offreIds)
        .in('candidat_id', candidatIds)
        .order('created_at', { ascending: false })
      : { data: [], error: null };
    if (matchsError) return res.status(400).json({ error: matchsError });

    const matchIds = (matchs || []).map((match) => match.id);
    const { data: messages, error: messagesError } = matchIds.length
      ? await supabase
        .from('messages')
        .select('match_id')
        .in('match_id', matchIds)
      : { data: [], error: null };
    if (messagesError) return res.status(400).json({ error: messagesError });

    const discussedMatchIds = new Set((messages || []).map((message) => String(message.match_id)));
    const matchesByPair = new Map();
    const matchesByCandidate = new Map();
    (matchs || []).forEach((match) => {
      const pairKey = `${match.offre_id}:${match.candidat_id}`;
      if (!matchesByPair.has(pairKey)) matchesByPair.set(pairKey, match);
      const candidateKey = String(match.candidat_id);
      if (!matchesByCandidate.has(candidateKey)) matchesByCandidate.set(candidateKey, []);
      matchesByCandidate.get(candidateKey).push(match);
    });

    const pipeline = { nouveau: [], contacte: [] };
    data.forEach((candidature) => {
      const candidateKey = String(candidature.candidat_id);
      const candidateMatches = matchesByCandidate.get(candidateKey) || [];
      const match = matchesByPair.get(`${candidature.offre_id}:${candidature.candidat_id}`) || candidateMatches[0] || null;
      const candidateMatchIds = candidateMatches.map((item) => item.id);
      const discussed = candidateMatchIds.some((id) => discussedMatchIds.has(String(id)));
      pipeline[discussed ? 'contacte' : 'nouveau'].push(normalizeCandidate(candidature, {
        match,
        matchIds: candidateMatchIds,
        discussed,
      }));
    });
    res.json(pipeline);
  } catch (error) {
    publicError(res, error);
  }
});

router.post('/pipeline/contact', authMiddleware, requireRecruiterPlan, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { candidature_id } = req.body;
    if (!candidature_id) return res.status(400).json({ error: 'candidature_id requis' });

    const { data: candidature, error: candidatureError } = await supabase
      .from('candidatures')
      .select('id, candidat_id, offre_id, candidats(id, user_id, nom, prenom, titre, score_adn), offres(id, titre, recruteur_id)')
      .eq('id', candidature_id)
      .maybeSingle();
    if (candidatureError) return res.status(400).json({ error: candidatureError });
    if (!candidature) return res.status(404).json({ error: 'Candidature introuvable' });
    if (String(candidature.offres?.recruteur_id) !== String(recruteur.id)) {
      return res.status(403).json({ error: 'Candidature non autorisee' });
    }

    const { data: existingMatches, error: existingError } = await supabase
      .from('matchs')
      .select('id, created_at')
      .eq('candidat_id', candidature.candidat_id)
      .eq('offre_id', candidature.offre_id)
      .order('created_at', { ascending: false });
    if (existingError) return res.status(400).json({ error: existingError });

    let match = existingMatches?.[0] || null;
    if (!match) {
      const score = Math.max(70, Number(candidature.candidats?.score_adn || 0));
      const { data: createdMatch, error: createError } = await supabase
        .from('matchs')
        .insert({
          candidat_id: candidature.candidat_id,
          offre_id: candidature.offre_id,
          score_match: score,
          score_compat: score,
        })
        .select('id, created_at')
        .single();
      if (createError) return res.status(400).json({ error: createError });
      match = createdMatch;
    }

    const candidat = candidature.candidats || {};
    if (!candidat.user_id) return res.status(400).json({ error: 'Candidat sans compte utilisateur' });
    const shortName = candidat.nom ? `${candidat.nom.slice(0, 1)}.` : '';
    const name = [candidat.prenom, shortName].filter(Boolean).join(' ') || 'Candidat';
    res.json({
      id: match.id,
      match_id: match.id,
      match_ids: [match.id],
      receiver_id: candidat.user_id,
      av: `${candidat.prenom?.[0] || ''}${candidat.nom?.[0] || ''}`.toUpperCase() || 'SF',
      bg: '#1340E0',
      nom: name,
      time: 'Maintenant',
      prev: `Match sur ${candidature.offres?.titre || 'votre offre'}`,
      ur: false,
      mine: true,
      read: null,
      status: '',
    });
  } catch (error) {
    publicError(res, error);
  }
});

router.put('/pipeline/move', authMiddleware, requireRecruiterPlan, (_req, res) => {
  res.status(405).json({
    error: 'PIPELINE_LOCKED',
    message: 'Le pipeline est en lecture seule.',
  });
});

router.post('/swipe', authMiddleware, requireRecruiterPlan, async (req, res) => {
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