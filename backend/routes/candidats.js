const express = require('express');
const router = express.Router();
const path = require('path');
const zlib = require('zlib');
const PDFDocument = require('pdfkit');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const requireCandidatePlan = require('../middleware/requireCandidatePlan');
const { ensureCandidateProfile, ensureRecruiterProfile, getCandidatePlan } = require('../utils/profiles');
const { askClaude } = require('../utils/anthropic');

// Score à partir duquel le profil est éligible à la certification SwipSales
// (candidat-visible uniquement — jamais exposé au recruteur, voir Notes.md).
const CERTIFICATION_SCORE_THRESHOLD = 80;

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
    const withUrls = await withFreshCvUrl(profil);
    // Certification SwipSales (palier Carrière Coaching) : visible UNIQUEMENT ici,
    // sur le propre profil du candidat. Ne jamais recalculer/exposer cette valeur
    // dans GET /deck (recruteur) — contrainte légale, voir Notes.md.
    const plan = await getCandidatePlan(req.user.id);
    const certifie = plan === 'carriere_coaching' && Number(profil.score_adn || 0) >= CERTIFICATION_SCORE_THRESHOLD;
    res.json({
      ...withUrls,
      ville: profil.axes?.meta?.ville || '',
      competences: profil.axes?.meta?.competences || {},
      certifie,
    });
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
    const { nom, prenom, titre, score_adn, axes, cv_url, motivation, anonyme, avatar_label, ville, competences } = req.body;
    const nextAxes = axes === undefined
      ? current.axes
      : {
        ...(current.axes || {}),
        ...(axes || {}),
      };
    if (motivation !== undefined || anonyme !== undefined || avatar_label !== undefined || ville !== undefined || competences !== undefined) {
      nextAxes.meta = {
        ...(current.axes?.meta || {}),
        ...(motivation !== undefined ? { motivation } : {}),
        ...(anonyme !== undefined ? { anonyme } : {}),
        ...(avatar_label !== undefined ? { avatar_label } : {}),
        ...(ville !== undefined ? { ville } : {}),
        ...(competences !== undefined ? { competences } : {}),
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
      supabase.from('candidatures').select('id, statut, lettre_type').eq('candidat_id', candidat.id)
        .or('lettre_type.is.null,lettre_type.neq.recruteur_like'),
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
    const requestedCompetences = req.query.competences
      ? String(req.query.competences).split(',').map((c) => c.trim()).filter(Boolean)
      : [];
    const seenCandidateIds = await recruiterSeenCandidateIds(req.user.id);
    const { data, error } = await supabase
      .from('candidats')
      .select('*')
      .order('score_adn', { ascending: false, nullsFirst: false });

    if (error) return res.status(400).json({ error });

    const candidates = dedupeBy(data, (candidat) => candidat.user_id || candidat.id)
      .filter((candidat) => candidat.user_id !== req.user.id)
      .filter((candidat) => !seenCandidateIds.includes(String(candidat.id)))
      .filter((candidat) => !seenCandidateIds.includes(String(candidat.user_id)))
      .filter((candidat) => {
        if (!requestedCompetences.length) return true;
        const competences = candidat.axes?.meta?.competences || {};
        const flat = Object.values(competences).flat();
        return requestedCompetences.some((c) => flat.includes(c));
      });

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
          certifie: false,
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
          competences: profile.axes?.meta?.competences || {},
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

// ------------------------------------------------------------
// RGPD : consentement, export, suppression de compte
// ------------------------------------------------------------

// Dernier consentement enregistré pour ce type (le plus récent fait foi).
router.get('/consentement/:type', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('consentements')
      .select('type, version, accepte, created_at')
      .eq('user_id', req.user.id)
      .eq('type', req.params.type)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return res.status(400).json({ error });
    res.json(data || { type: req.params.type, accepte: false });
  } catch (error) {
    publicError(res, error);
  }
});

// Chaque appel crée une nouvelle ligne (jamais d'update) : preuve horodatée de
// quelle version du texte a été acceptée ou refusée, conservée même si le texte
// change ensuite. Voir backend/supabase_rgpd_consentement.sql pour le schéma.
router.post('/consentement', authMiddleware, async (req, res) => {
  try {
    const { type, version, accepte } = req.body || {};
    if (!type || !version || typeof accepte !== 'boolean') {
      return res.status(400).json({ error: 'type, version et accepte (booleen) sont requis' });
    }

    const { data, error } = await supabase
      .from('consentements')
      .insert({ user_id: req.user.id, type, version, accepte })
      .select('type, version, accepte, created_at')
      .single();

    if (error) return res.status(400).json({ error });
    res.json(data);
  } catch (error) {
    publicError(res, error);
  }
});

// Export RGPD (droit à la portabilité) : uniquement les données du candidat connecté.
router.get('/export', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);

    const [userRow, candidatures, matchs, consentements] = await Promise.all([
      supabase.from('users').select('id, email, role, created_at').eq('id', req.user.id).maybeSingle(),
      supabase.from('candidatures').select('id, offre_id, statut, lettre_type, created_at').eq('candidat_id', candidat.id),
      supabase.from('matchs').select('id, offre_id, score_match, score_compat, created_at').eq('candidat_id', candidat.id),
      supabase.from('consentements').select('type, version, accepte, created_at').eq('user_id', req.user.id).order('created_at', { ascending: true }),
    ]);

    if (userRow.error) return res.status(400).json({ error: userRow.error });
    if (candidatures.error) return res.status(400).json({ error: candidatures.error });
    if (matchs.error) return res.status(400).json({ error: matchs.error });
    if (consentements.error) return res.status(400).json({ error: consentements.error });

    res.json({
      export_genere_le: new Date().toISOString(),
      compte: userRow.data,
      profil: {
        nom: candidat.nom || '',
        prenom: candidat.prenom || '',
        titre: candidat.titre || '',
        ville: candidat.axes?.meta?.ville || '',
        score_adn: candidat.score_adn ?? null,
        resultat_test_adn: candidat.axes?.resultat || null,
        reponses_test_adn: candidat.axes?.questionnaire || null,
        competences: candidat.axes?.meta?.competences || {},
      },
      candidatures: candidatures.data,
      matchs: matchs.data,
      consentements: consentements.data,
    });
  } catch (error) {
    publicError(res, error);
  }
});

// Suppression de compte (droit à l'effacement). Confirmation explicite requise
// côté client ET revérifiée ici. Stratégie : anonymiser plutôt que supprimer les
// lignes candidats/users (matchs, candidatures et messages passés les référencent
// par id — les supprimer casserait l'affichage côté recruteur), supprimer pour de
// vrai les fichiers uploadés (CV, lettre, photo), et supprimer réellement
// l'identité Supabase Auth pour que la connexion soit définitivement impossible.
router.delete('/compte', authMiddleware, async (req, res) => {
  try {
    const { confirmation } = req.body || {};
    if (confirmation !== 'SUPPRIMER') {
      return res.status(400).json({ error: 'Confirmation manquante ou invalide' });
    }

    const candidat = await ensureCandidateProfile(req.user.id);
    const meta = candidat.axes?.meta || {};

    await Promise.all([
      removeStorageFile(meta.cv_bucket || CV_BUCKET, meta.cv_path),
      removeStorageFile(meta.motivation_bucket || CV_BUCKET, meta.motivation_path),
      removeStorageFile(meta.avatar_bucket || AVATAR_BUCKET, meta.avatar_path),
    ]);

    const { error: candidatError } = await supabase
      .from('candidats')
      .update({
        nom: null,
        prenom: null,
        titre: null,
        cv_url: null,
        score_adn: null,
        axes: {},
        swipes_meta: {},
        contacts_meta: {},
      })
      .eq('user_id', req.user.id);
    if (candidatError) return res.status(400).json({ error: candidatError });

    const { error: userError } = await supabase
      .from('users')
      .update({ email: `supprime-${req.user.id}@deleted.invalid` })
      .eq('id', req.user.id);
    if (userError) return res.status(400).json({ error: userError });

    const { error: authError } = await supabase.auth.admin.deleteUser(req.user.id);
    if (authError) return res.status(400).json({ error: authError.message || authError });

    res.json({ message: 'Compte supprimé' });
  } catch (error) {
    publicError(res, error);
  }
});

// ------------------------------------------------------------
// Carrière / Carrière Coaching — historique, export PDF, benchmark, certification
// ------------------------------------------------------------

// Historique des évaluations (palier Carrière Coaching : ré-évaluation semestrielle).
router.get('/evaluations', authMiddleware, requireCandidatePlan('carriere_coaching'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('evaluations_adn')
      .select('score, resultat, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: true });
    if (error) return res.status(400).json({ error });

    const last = data[data.length - 1];
    const nextEligibleAt = last
      ? new Date(new Date(last.created_at).getTime() + 6 * 30 * 24 * 60 * 60 * 1000).toISOString()
      : null;

    res.json({
      evaluations: data,
      next_eligible_at: nextEligibleAt,
      peut_repasser: !nextEligibleAt || new Date(nextEligibleAt).getTime() <= Date.now(),
    });
  } catch (error) {
    publicError(res, error);
  }
});

// Export PDF du dernier résultat (palier Carrière : "restitution PDF téléchargeable").
router.get('/export-pdf', authMiddleware, requireCandidatePlan('carriere'), async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const resultat = candidat.axes?.resultat;
    if (!resultat) {
      return res.status(400).json({ error: 'Aucun résultat de test ADN à exporter — passez le test ADN d\'abord' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="swipsales-resultat-adn.pdf"');

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    doc.fontSize(22).text('SwipSales — Résultat du test ADN commercial', { align: 'left' });
    doc.moveDown();
    const nom = [candidat.prenom, candidat.nom].filter(Boolean).join(' ') || 'Candidat';
    doc.fontSize(11).fillColor('#555').text(nom);
    doc.text('Généré le ' + new Date().toLocaleDateString('fr-FR'));
    doc.moveDown(1.5);

    doc.fillColor('#000').fontSize(16).text('Score global : ' + resultat.score + ' / 100');
    if (resultat.type) doc.fontSize(12).fillColor('#555').text(resultat.type);
    doc.moveDown();

    if (Array.isArray(resultat.axes) && resultat.axes.length) {
      doc.fillColor('#000').fontSize(14).text('Axes');
      doc.moveDown(0.5);
      resultat.axes.forEach((axe) => {
        doc.fontSize(11).text(`${axe.l} : ${axe.v} / 100`);
      });
      doc.moveDown();
    }

    if (resultat.desc) {
      doc.fontSize(11).fillColor('#333').text(resultat.desc);
    }

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#999').text(
      'Ce résultat est indicatif et sert au matching avec les recruteurs sur SwipSales. Il ne constitue pas une évaluation psychométrique certifiée.',
      { width: 480 }
    );

    doc.end();
  } catch (error) {
    publicError(res, error);
  }
});

// Benchmark anonymisé par typologie de poste (palier Carrière Coaching). Ne renvoie
// qu'une moyenne agrégée, jamais de données individuelles — et rien du tout si
// l'échantillon est trop petit pour être anonyme (seuil k=5), plutôt qu'un chiffre
// qui identifierait de fait 1-4 personnes précises.
const BENCHMARK_MIN_SAMPLE = 5;
router.get('/benchmark', authMiddleware, requireCandidatePlan('carriere_coaching'), async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const typePoste = candidat.type_poste;
    if (!typePoste) {
      return res.status(400).json({ error: 'Passez le test ADN pour connaître votre typologie de poste' });
    }

    const { data, error } = await supabase
      .from('candidats')
      .select('score_adn, axes')
      .eq('type_poste', typePoste)
      .not('score_adn', 'is', null);
    if (error) return res.status(400).json({ error });

    if (data.length < BENCHMARK_MIN_SAMPLE) {
      return res.json({
        type_poste: typePoste,
        assez_de_donnees: false,
        echantillon: data.length,
        message: 'Pas encore assez de candidats sur cette typologie de poste pour un benchmark anonyme et fiable.',
      });
    }

    const scores = data.map((c) => Number(c.score_adn || 0));
    const moyenne = Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length);
    const sorted = [...scores].sort((a, b) => a - b);
    const votrePosition = sorted.filter((s) => s <= candidat.score_adn).length;
    const percentile = Math.round((votrePosition / sorted.length) * 100);

    res.json({
      type_poste: typePoste,
      assez_de_donnees: true,
      echantillon: data.length,
      moyenne,
      votre_score: candidat.score_adn,
      percentile,
    });
  } catch (error) {
    publicError(res, error);
  }
});

// Statut de certification (candidat-visible uniquement, voir GET /profil pour le
// détail du garde-fou). Génère un lien de partage public minimal, sans OAuth
// LinkedIn (retiré volontairement du projet par le passé) — l'utilisateur poste
// lui-même le lien.
router.get('/certification', authMiddleware, requireCandidatePlan('carriere_coaching'), async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const certifie = Number(candidat.score_adn || 0) >= CERTIFICATION_SCORE_THRESHOLD;
    const partagePublic = candidat.axes?.meta?.certificat_public === true;
    res.json({
      certifie,
      score_requis: CERTIFICATION_SCORE_THRESHOLD,
      score_actuel: candidat.score_adn || 0,
      partage_active: partagePublic,
      lien_partage: certifie && partagePublic ? `/certificat.html?id=${candidat.id}` : null,
    });
  } catch (error) {
    publicError(res, error);
  }
});

// Active/désactive explicitement le partage public du badge — désactivé par défaut,
// pas d'exposition publique tant que le candidat n'a pas cliqué lui-même.
router.post('/certification/partage', authMiddleware, requireCandidatePlan('carriere_coaching'), async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const active = req.body?.actif === true;
    const nextAxes = {
      ...(candidat.axes || {}),
      meta: { ...(candidat.axes?.meta || {}), certificat_public: active },
    };
    const { error } = await supabase.from('candidats').update({ axes: nextAxes }).eq('user_id', req.user.id);
    if (error) return res.status(400).json({ error });
    res.json({ partage_active: active, lien_partage: active ? `/certificat.html?id=${candidat.id}` : null });
  } catch (error) {
    publicError(res, error);
  }
});

// Page publique de certification — volontairement minimale (score + prénom optionnel),
// aucune autre donnée du profil. Pas d'authentification : c'est le lien que le
// candidat partage lui-même (LinkedIn, etc.). 404 si le candidat n'est pas certifié
// ou a désactivé le partage, pour ne jamais confirmer/infirmer l'existence d'un id.
router.get('/:id/certificat-public', async (req, res) => {
  try {
    const { data: candidat, error } = await supabase
      .from('candidats')
      .select('id, prenom, score_adn, axes')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) return res.status(400).json({ error });

    const partagePublic = candidat?.axes?.meta?.certificat_public === true; // opt-in explicite uniquement
    const certifie = candidat && Number(candidat.score_adn || 0) >= CERTIFICATION_SCORE_THRESHOLD;
    if (!candidat || !certifie || !partagePublic) {
      return res.status(404).json({ error: 'Certificat introuvable' });
    }

    res.json({
      prenom: candidat.prenom || 'Un commercial',
      score: candidat.score_adn,
      certifie: true,
    });
  } catch (error) {
    publicError(res, error);
  }
});

// Optimisation CV/pitch (palier Carrière). Relecture par Claude, retour de
// suggestions structurées — jamais une réécriture automatique du document.
const CV_PITCH_SYSTEM_PROMPT = `Tu es un relecteur expert en CV et pitchs commerciaux (SDR, Account Executive, Key Account Manager, commercial terrain). Tu donnes un retour concret et actionnable pour un candidat SwipSales, jamais une réécriture complète — des suggestions ciblées.

Structure toujours ta réponse en 3 parties courtes :
1. Points forts (2-3 points max)
2. Points à améliorer (2-4 points max, concrets et actionnables)
3. Une suggestion de reformulation pour l'élément le plus faible

Reste concis (300 mots maximum), en français, orienté résultats commerciaux.`;

router.post('/optimiser-cv', authMiddleware, requireCandidatePlan('carriere'), async (req, res) => {
  try {
    // Fichier envoyé directement (nouveau CV), sinon on relit le CV déjà enregistré
    // sur le profil — évite de forcer un nouvel upload juste pour l'analyser.
    const isMultipart = /multipart\/form-data/i.test(req.headers['content-type'] || '');
    let text;
    if (isMultipart) {
      const file = await getMultipartFile(req, 'cv');
      validateCvFile(file);
      text = extractCvText(file);
    } else {
      const candidat = await ensureCandidateProfile(req.user.id);
      const meta = candidat.axes?.meta || {};
      if (!meta.cv_path) {
        return res.status(400).json({ error: 'Aucun CV enregistré sur votre profil — importez-en un d\'abord' });
      }
      const { data: fileData, error: downloadError } = await supabase.storage
        .from(meta.cv_bucket || CV_BUCKET)
        .download(meta.cv_path);
      if (downloadError) return res.status(400).json({ error: downloadError });
      const buffer = Buffer.from(await fileData.arrayBuffer());
      text = extractCvText({ filename: meta.cv_file_name || 'cv.pdf', buffer });
    }
    if (!text || text.length < 50) {
      return res.status(400).json({ error: 'Impossible d\'extraire assez de texte de ce CV pour l\'analyser' });
    }

    const suggestions = await askClaude({
      system: CV_PITCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Voici le texte extrait d'un CV commercial :\n\n${text.slice(0, 6000)}` }],
      maxTokens: 700,
    });

    res.json({ suggestions });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

router.post('/optimiser-pitch', authMiddleware, requireCandidatePlan('carriere'), async (req, res) => {
  try {
    const texte = String(req.body?.texte || '').trim();
    if (!texte || texte.length < 20) {
      return res.status(400).json({ error: 'Texte de pitch trop court à analyser' });
    }
    if (texte.length > 4000) {
      return res.status(400).json({ error: 'Texte trop long (4000 caractères max)' });
    }

    const suggestions = await askClaude({
      system: CV_PITCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Voici un pitch/lettre de motivation commercial à relire :\n\n${texte}` }],
      maxTokens: 700,
    });

    res.json({ suggestions });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

module.exports = router;