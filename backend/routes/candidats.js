const express = require('express');
const router = express.Router();
const path = require('path');
const zlib = require('zlib');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureCandidateProfile, ensureRecruiterProfile } = require('../utils/profiles');

const CV_BUCKET = process.env.CV_BUCKET || 'candidate-cvs';
const AVATAR_BUCKET = process.env.AVATAR_BUCKET || 'profile-photos';
const MAX_CV_BYTES = Number(process.env.MAX_CV_UPLOAD_MB || 8) * 1024 * 1024;
const MAX_AVATAR_BYTES = Number(process.env.MAX_AVATAR_UPLOAD_MB || 3) * 1024 * 1024;
const CV_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);
const AVATAR_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function definedOnly(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

function publicError(res, error) {
  return res.status(error.status || 400).json({ error: error.message || error });
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

async function getMultipartFile(req, fieldName, maxBytes = MAX_CV_BYTES, label = 'Fichier') {
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

function validateProfileDocument(file, label = 'CV') {
  const ext = path.extname(file.filename).toLowerCase();
  if (!CV_EXTENSIONS.has(ext)) {
    const error = new Error(`Format ${label} non supporte. Utilisez PDF, DOC ou DOCX.`);
    error.status = 400;
    throw error;
  }
  if (!file.buffer.length) {
    const error = new Error(`${label} vide`);
    error.status = 400;
    throw error;
  }
}

function validateCvFile(file) {
  validateProfileDocument(file, 'CV');
}

function validateMotivationFile(file) {
  validateProfileDocument(file, 'lettre de motivation');
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

function cleanExtractedText(text = '') {
  return text
    .replace(/\u0000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeXmlEntities(text = '') {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractDocxText(buffer) {
  const eocdMin = Math.max(0, buffer.length - 65557);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= eocdMin; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset === -1) return '';

  const entries = buffer.readUInt16LE(eocdOffset + 10);
  let cursor = buffer.readUInt32LE(eocdOffset + 16);
  const xmlTexts = [];

  for (let index = 0; index < entries && cursor + 46 < buffer.length; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;

    const compression = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    if (name === 'word/document.xml' || /^word\/(header|footer)\d*\.xml$/.test(name)) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataStart, dataStart + compressedSize);
      const raw = compression === 8
        ? zlib.inflateRawSync(compressed)
        : compression === 0
          ? compressed
          : Buffer.alloc(0);
      const xml = raw.toString('utf8')
        .replace(/<w:tab\/>/g, ' ')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, ' ');
      xmlTexts.push(decodeXmlEntities(xml));
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return cleanExtractedText(xmlTexts.join('\n'));
}

function extractPdfText(buffer) {
  const source = buffer.toString('latin1');
  const chunks = [];
  const stringPattern = /\((?:\\.|[^\\)]){2,}\)/g;
  let match;

  while ((match = stringPattern.exec(source))) {
    chunks.push(match[0]
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n')
      .replace(/\\t/g, ' ')
      .replace(/\\([()\\])/g, '$1'));
  }

  const utf8Text = buffer.toString('utf8').replace(/[^\x09\x0a\x0d\x20-\x7EÀ-ÿ]/g, ' ');
  return cleanExtractedText([...chunks, utf8Text].join('\n'));
}

function extractLegacyDocText(buffer) {
  const latin = buffer.toString('latin1').replace(/[^\x09\x0a\x0d\x20-\x7EÀ-ÿ]/g, ' ');
  const utf16 = buffer.toString('utf16le').replace(/[^\x09\x0a\x0d\x20-\x7EÀ-ÿ]/g, ' ');
  return cleanExtractedText(`${latin}\n${utf16}`);
}

function extractCvText(file) {
  const ext = path.extname(file.filename).toLowerCase();
  try {
    if (ext === '.docx') return extractDocxText(file.buffer);
    if (ext === '.pdf') return extractPdfText(file.buffer);
    if (ext === '.doc') return extractLegacyDocText(file.buffer);
  } catch (error) {
    console.warn('Extraction CV impossible:', error.message || error);
  }
  return '';
}

function titleCaseName(value = '') {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function guessNameFromTokens(tokens = []) {
  const blacklist = new Set(['cv', 'resume', 'curriculum', 'vitae', 'profil', 'commercial', 'sales']);
  const clean = tokens
    .map((token) => token.replace(/[^a-zA-ZÀ-ÿ'-]/g, ''))
    .filter((token) => token.length > 1 && !blacklist.has(token.toLowerCase()));

  if (clean.length < 2) return {};
  return {
    prenom: titleCaseName(clean[0]),
    nom: titleCaseName(clean.slice(1, 3).join(' ')),
  };
}

function guessName(text, email, filename) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 5 && line.length <= 70)
    .filter((line) => !/@|https?:|www\.|\d{4,}/i.test(line));

  for (const line of lines.slice(0, 12)) {
    const words = line.split(/\s+/);
    if (words.length >= 2 && words.length <= 4 && words.every((word) => /^[A-ZÀ-Ý][a-zA-ZÀ-ÿ'-]+$/.test(word))) {
      return guessNameFromTokens(words);
    }
  }

  if (email) {
    const local = email.split('@')[0].split(/[._-]+/);
    const fromEmail = guessNameFromTokens(local);
    if (fromEmail.prenom && fromEmail.nom) return fromEmail;
  }

  const fromFilename = path.basename(filename, path.extname(filename)).split(/[._\-\s]+/);
  return guessNameFromTokens(fromFilename);
}

function extractCvAutofill(file) {
  const text = extractCvText(file);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || '';
  return {
    ...guessName(text, email, file.filename),
    email,
    extracted: Boolean(text),
  };
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

async function withFreshCvUrl(profile) {
  const cvPath = profile?.axes?.meta?.cv_path;
  const cvBucket = profile?.axes?.meta?.cv_bucket || CV_BUCKET;
  const motivationPath = profile?.axes?.meta?.motivation_path;
  const motivationBucket = profile?.axes?.meta?.motivation_bucket || CV_BUCKET;
  const avatarPath = profile?.axes?.meta?.avatar_path;
  const avatarBucket = profile?.axes?.meta?.avatar_bucket || AVATAR_BUCKET;
  let nextProfile = profile;

  const [cvResult, motivationResult, avatarResult] = await Promise.all([
    cvPath
      ? supabase.storage.from(cvBucket).createSignedUrl(cvPath, 60 * 60 * 24 * 7)
      : Promise.resolve(null),
    motivationPath
      ? supabase.storage.from(motivationBucket).createSignedUrl(motivationPath, 60 * 60 * 24 * 7)
      : Promise.resolve(null),
    avatarPath
      ? supabase.storage.from(avatarBucket).createSignedUrl(avatarPath, 60 * 60 * 24)
      : Promise.resolve(null),
  ]);

  if (cvResult && !cvResult.error && cvResult.data?.signedUrl) {
    nextProfile = { ...nextProfile, cv_url: cvResult.data.signedUrl };
  }
  if (motivationResult && !motivationResult.error && motivationResult.data?.signedUrl) {
    nextProfile = { ...nextProfile, motivation_url: motivationResult.data.signedUrl };
  }
  if (avatarResult && !avatarResult.error && avatarResult.data?.signedUrl) {
    nextProfile = { ...nextProfile, avatar_url: avatarResult.data.signedUrl };
  }

  return nextProfile;
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
    publicError(res, error);
  }
});

router.post('/analyse-cv', async (req, res) => {
  try {
    const file = await getMultipartFile(req, 'cv');
    validateCvFile(file);
    res.json({ fields: extractCvAutofill(file) });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

async function uploadCv(req, res) {
  try {
    const current = await ensureCandidateProfile(req.user.id);
    const file = await getMultipartFile(req, 'cv');
    validateCvFile(file);
    const autofill = extractCvAutofill(file);
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

    const profilePatch = {
      cv_url: signed?.signedUrl || storagePath,
      axes: nextAxes,
    };
    if (autofill.prenom && !current.prenom) profilePatch.prenom = autofill.prenom;
    if (autofill.nom && !current.nom) profilePatch.nom = autofill.nom;

    const { data, error } = await supabase
      .from('candidats')
      .update(profilePatch)
      .eq('user_id', req.user.id)
      .select('*')
      .single();

    if (error) throw error;

    res.json({
      message: 'CV importe',
      cv_url: signed?.signedUrl || storagePath,
      cv_file_name: file.filename,
      cv_autofill: autofill,
      candidat: data,
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
}

async function uploadMotivation(req, res) {
  try {
    const current = await ensureCandidateProfile(req.user.id);
    const file = await getMultipartFile(req, 'motivation');
    validateMotivationFile(file);
    await ensureCvBucket();

    const storagePath = `${req.user.id}/motivation-${Date.now()}-${file.filename}`;
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
        motivation_bucket: CV_BUCKET,
        motivation_path: storagePath,
        motivation_file_name: file.filename,
        motivation_uploaded_at: new Date().toISOString(),
      },
    };

    const { data: signed } = await supabase.storage
      .from(CV_BUCKET)
      .createSignedUrl(storagePath, 60 * 60 * 24 * 7);

    const { data, error } = await supabase
      .from('candidats')
      .update({ axes: nextAxes })
      .eq('user_id', req.user.id)
      .select('*')
      .single();

    if (error) throw error;

    res.json({
      message: 'Lettre de motivation importee',
      motivation_url: signed?.signedUrl || storagePath,
      motivation_file_name: file.filename,
      candidat: data,
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
}

function omitKeys(obj = {}, keys = []) {
  const blocked = new Set(keys);
  return Object.fromEntries(Object.entries(obj || {}).filter(([key]) => !blocked.has(key)));
}

async function removeStorageFile(bucket, storagePath) {
  if (!storagePath) return;
  const { error } = await supabase.storage.from(bucket).remove([storagePath]);
  if (error && !/not found|not exist|missing/i.test(error.message || '')) {
    console.warn('Suppression storage impossible:', error.message || error);
  }
}

async function uploadAvatar(req, res) {
  try {
    const current = await ensureCandidateProfile(req.user.id);
    const file = await getMultipartFile(req, 'avatar', MAX_AVATAR_BYTES, 'Photo');
    validateAvatarFile(file);
    await ensureAvatarBucket();

    const previousMeta = current.axes?.meta || {};
    const storagePath = `${req.user.id}/avatar-${Date.now()}-${file.filename}`;
    const { error: uploadError } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.contentType,
        upsert: false,
      });

    if (uploadError) throw uploadError;

    await removeStorageFile(previousMeta.avatar_bucket || AVATAR_BUCKET, previousMeta.avatar_path);

    const nextAxes = {
      ...(current.axes || {}),
      meta: {
        ...previousMeta,
        avatar_bucket: AVATAR_BUCKET,
        avatar_path: storagePath,
        avatar_file_name: file.filename,
        avatar_uploaded_at: new Date().toISOString(),
      },
    };

    const { data: signed } = await supabase.storage
      .from(AVATAR_BUCKET)
      .createSignedUrl(storagePath, 60 * 60 * 24);

    const { data, error } = await supabase
      .from('candidats')
      .update({ axes: nextAxes })
      .eq('user_id', req.user.id)
      .select('*')
      .single();

    if (error) throw error;

    res.json({
      message: 'Photo de profil mise a jour',
      avatar_url: signed?.signedUrl || '',
      avatar_file_name: file.filename,
      candidat: data,
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
}

async function deleteProfileDocument(req, res, kind) {
  try {
    const current = await ensureCandidateProfile(req.user.id);
    const meta = current.axes?.meta || {};
    const isCv = kind === 'cv';
    const bucket = isCv ? (meta.cv_bucket || CV_BUCKET) : (meta.motivation_bucket || CV_BUCKET);
    const storagePath = isCv ? meta.cv_path : meta.motivation_path;
    const keys = isCv
      ? ['cv_bucket', 'cv_path', 'cv_file_name', 'cv_uploaded_at']
      : ['motivation_bucket', 'motivation_path', 'motivation_file_name', 'motivation_uploaded_at'];

    await removeStorageFile(bucket, storagePath);

    const nextAxes = {
      ...(current.axes || {}),
      meta: omitKeys(meta, keys),
    };
    const patch = isCv ? { axes: nextAxes, cv_url: null } : { axes: nextAxes };

    const { data, error } = await supabase
      .from('candidats')
      .update(patch)
      .eq('user_id', req.user.id)
      .select('*')
      .single();

    if (error) throw error;
    res.json({ message: isCv ? 'CV supprime' : 'Lettre de motivation supprimee', candidat: data });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
}

router.post('/cv', authMiddleware, uploadCv);
router.post('/import-cv', authMiddleware, uploadCv);
router.post('/motivation', authMiddleware, uploadMotivation);
router.post('/avatar', authMiddleware, uploadAvatar);
router.delete('/cv', authMiddleware, (req, res) => deleteProfileDocument(req, res, 'cv'));
router.delete('/motivation', authMiddleware, (req, res) => deleteProfileDocument(req, res, 'motivation'));

router.put('/profil', authMiddleware, async (req, res) => {
  try {
    await ensureCandidateProfile(req.user.id);

    const current = await ensureCandidateProfile(req.user.id);
    const { nom, prenom, titre, score_adn, axes, cv_url, motivation, anonyme, avatar_label } = req.body;
    const nextAxes = axes === undefined
      ? current.axes
      : {
        ...(current.axes || {}),
        ...(axes || {}),
      };
    if (motivation !== undefined || anonyme !== undefined || avatar_label !== undefined) {
      nextAxes.meta = {
        ...(current.axes?.meta || {}),
        ...(motivation !== undefined ? { motivation } : {}),
        ...(anonyme !== undefined ? { anonyme } : {}),
        ...(avatar_label !== undefined ? { avatar_label } : {}),
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
    publicError(res, error);
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
    publicError(res, error);
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

    const candidates = dedupeBy(data, (candidat) => candidat.user_id || candidat.id)
      .filter((candidat) => candidat.user_id !== req.user.id)
      .filter((candidat) => !seenCandidateIds.includes(String(candidat.id)))
      .filter((candidat) => !seenCandidateIds.includes(String(candidat.user_id)));

    const deck = await Promise.all(candidates.map(async (candidat) => {
        const profile = await withFreshCvUrl(candidat);
        const axes = normalizeAxes(profile.axes);
        const anon = profile.axes?.meta?.anonyme === true;
        const shortName = profile.nom ? `${profile.nom.slice(0, 1)}.` : '';
        const name = anon
          ? 'Candidat anonyme'
          : [profile.prenom, shortName].filter(Boolean).join(' ') || 'Candidat';
        const initials = anon
          ? '?'
          : `${profile.prenom?.[0] || ''}${profile.nom?.[0] || ''}`.toUpperCase() || 'SF';
        const skills = Object.keys(axes).filter((key) => typeof axes[key] === 'number').slice(0, 5);

        return {
          id: profile.id,
          user_id: profile.user_id,
          name,
          initiales: initials,
          role: profile.titre || 'Commercial',
          anon,
          avatar_url: anon ? '' : (profile.avatar_url || ''),
          m: compatibilityScore(axes, matching),
          adn_score: profile.score_adn || 0,
          adn_type: profile.axes?.resultat?.type || profile.axes?.resultat?.type_profil || 'Profil commercial',
          rank: profile.axes?.resultat?.rank || 'Profil verifie',
          axes: Object.entries(axes)
            .filter(([, value]) => typeof value === 'number')
            .slice(0, 6)
            .map(([l, v]) => ({ l, v })),
          pitch_score: profile.axes?.resultat?.pitch_score || profile.score_adn || 0,
          pitch_text: profile.axes?.resultat?.desc || profile.axes?.meta?.motivation || 'Profil candidat synchronise avec la base.',
          letter_text: profile.axes?.meta?.motivation || profile.titre || 'Lettre de motivation non renseignee.',
          letter_audio: Boolean(profile.axes?.meta?.audio_url),
          letter_video: Boolean(profile.axes?.meta?.video_url),
          cv_url: profile.cv_url || '',
          cv_file_name: profile.axes?.meta?.cv_file_name || '',
          motivation_url: profile.motivation_url || '',
          motivation_file_name: profile.axes?.meta?.motivation_file_name || '',
          skills: skills.length ? skills : ['Sales', 'B2B'],
          ai: profile.axes?.resultat?.desc || 'Analyse basee sur le score ADN et les axes renseignes.',
          predict: [
            { v: `${compatibilityScore(axes, matching)}%`, l: 'Fit poste' },
            { v: profile.score_adn || 0, l: 'ADN' },
            { v: 'Base', l: 'Source' },
          ],
        };
      }));

    res.json(deck);
  } catch (error) {
    publicError(res, error);
  }
});

module.exports = router;