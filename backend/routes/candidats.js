const express = require('express');
const router = express.Router();
const path = require('path');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureCandidateProfile, ensureRecruiterProfile } = require('../utils/profiles');

const CV_BUCKET = process.env.CV_BUCKET || 'candidate-cvs';
const MAX_CV_BYTES = Number(process.env.MAX_CV_UPLOAD_MB || 8) * 1024 * 1024;
const CV_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);

function definedOnly(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

function sanitizeFilename(filename = 'cv.pdf') {
  const clean = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '-');
  return clean || 'cv.pdf';
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

function readRequestBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('CV trop volumineux');
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

async function getMultipartFile(req, fieldName) {
  const contentType = req.headers['content-type'] || '';
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1]
    || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];

  if (!boundary) {
    const error = new Error('Formulaire multipart invalide');
    error.status = 400;
    throw error;
  }

  const body = await readRequestBuffer(req, MAX_CV_BYTES);
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

  const error = new Error('Fichier CV manquant');
  error.status = 400;
  throw error;
}

function validateCvFile(file) {
  const ext = path.extname(file.filename).toLowerCase();
  if (!CV_EXTENSIONS.has(ext)) {
    const error = new Error('Format CV non supporte. Utilisez PDF, DOC ou DOCX.');
    error.status = 400;
    throw error;
  }
  if (!file.buffer.length) {
    const error = new Error('CV vide');
    error.status = 400;
    throw error;
  }
}

async function ensureCvBucket() {
  const existing = await supabase.storage.getBucket(CV_BUCKET);
  if (!existing.error) return;

  const { error } = await supabase.storage.createBucket(CV_BUCKET, {
    public: false,
    allowedMimeTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    fileSizeLimit: MAX_CV_BYTES,
  });

  if (error && !/already|exist/i.test(error.message || '')) throw error;
}

async function withFreshCvUrl(profile) {
  const cvPath = profile?.axes?.meta?.cv_path;
  const cvBucket = profile?.axes?.meta?.cv_bucket || CV_BUCKET;
  if (!cvPath) return profile;

  const { data, error } = await supabase.storage
    .from(cvBucket)
    .createSignedUrl(cvPath, 60 * 60 * 24 * 7);

  if (error || !data?.signedUrl) return profile;
  return { ...profile, cv_url: data.signedUrl };
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
    res.json(await withFreshCvUrl(profil));
  } catch (error) {
    res.status(400).json({ error });
  }
});

async function uploadCv(req, res) {
  try {
    const current = await ensureCandidateProfile(req.user.id);
    const file = await getMultipartFile(req, 'cv');
    validateCvFile(file);
    await ensureCvBucket();

    const storagePath = `${req.user.id}/${Date.now()}-${file.filename}`;
    const { error: uploadError } = await supabase.storage
      .from(CV_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.contentType,
        upsert: false,
      });

    if (uploadError) throw uploadError;

    const nextAxes = {
      ...(current.axes || {}),
      meta: {
        ...(current.axes?.meta || {}),
        cv_bucket: CV_BUCKET,
        cv_path: storagePath,
        cv_file_name: file.filename,
        cv_uploaded_at: new Date().toISOString(),
      },
    };

    const { data: signed } = await supabase.storage
      .from(CV_BUCKET)
      .createSignedUrl(storagePath, 60 * 60 * 24 * 7);

    const { data, error } = await supabase
      .from('candidats')
      .update({
        cv_url: signed?.signedUrl || storagePath,
        axes: nextAxes,
      })
      .eq('user_id', req.user.id)
      .select('*')
      .single();

    if (error) throw error;

    res.json({
      message: 'CV importe',
      cv_url: signed?.signedUrl || storagePath,
      cv_file_name: file.filename,
      candidat: data,
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
}

router.post('/cv', authMiddleware, uploadCv);
router.post('/import-cv', authMiddleware, uploadCv);

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
