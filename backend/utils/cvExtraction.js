const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MESSAGES = {
  CV_PDF_INVALID: 'Ce PDF est corrompu ou invalide. Exportez à nouveau votre CV en PDF ou utilisez un fichier DOCX.',
  CV_PDF_PROTECTED: 'Ce PDF est protégé par un mot de passe. Fournissez une copie sans protection ou un fichier DOCX.',
  CV_EXTRACTION_TIMEOUT: 'La lecture du document a pris trop de temps. Essayez un PDF plus simple, un DOCX ou collez le texte du CV.',
  CV_EXTRACTION_BUSY: 'La lecture des documents est momentanément occupée. Réessayez dans quelques instants ou collez votre texte.',
  CV_EXTRACTION_FAILED: 'Le texte du document ne peut pas être extrait. Exportez à nouveau le fichier ou collez le texte du CV.',
  CV_LEGACY_DOC: "Ce format Word ancien n'est pas pris en charge. Enregistrez votre CV en .docx ou PDF.",
  CV_FORMAT_UNSUPPORTED: 'Format non pris en charge. Utilisez un PDF ou un DOCX, ou collez le texte du CV.',
  CV_FILE_TOO_LARGE: 'Le fichier dépasse la limite de 8 Mo. Fournissez un fichier plus léger ou collez le texte du CV.',
};
function extractionError(code) {
  return Object.assign(new Error(MESSAGES[code] || MESSAGES.CV_EXTRACTION_FAILED), {
    code, status: code === 'CV_FILE_TOO_LARGE' ? 413 : code === 'CV_EXTRACTION_BUSY' ? 503 : 422,
  });
}
function textState(text, filename) {
  const readable = text.length >= 200;
  const tooLong = text.length > 30000;
  return {
    readable, analysable: readable && !tooLong, length: text.length,
    code: tooLong ? 'CV_TEXT_TOO_LONG' : readable ? null : 'CV_TEXT_INSUFFICIENT',
    message: tooLong
      ? `Le CV contient ${text.length} caractères de texte ; la limite est de 30 000. Modifiez ou collez le texte à analyser, ou fournissez une version plus concise. Le document original est conservé.`
      : readable ? '' : /\.pdf$/i.test(filename)
        ? "Nous n'avons pas trouvé suffisamment de texte dans ce PDF (200 caractères minimum). Il semble être scanné ou composé d'images. Essayez un PDF avec texte sélectionnable, un fichier DOCX ou collez directement le contenu de votre CV."
        : 'Le document contient moins de 200 caractères de texte. Complétez ou collez le contenu de votre CV pour continuer.',
  };
}
let active = 0;
function extractPdfText(buffer, { timeoutMs = 30000 } = {}) {
  if (active >= 2) return Promise.reject(extractionError('CV_EXTRACTION_BUSY'));
  active += 1;
  return new Promise((resolve, reject) => {
    let worker;
    let timer;
    let settled = false;
    const finish = async (error, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) await worker.terminate().catch(() => {});
      active -= 1;
      if (error) reject(error); else resolve(text);
    };
    try {
      worker = new Worker(path.join(__dirname, 'cvPdfWorker.js'), {
        workerData: new Uint8Array(buffer),
        resourceLimits: { maxOldGenerationSizeMb: 128 },
        // PDF.js diagnostics may contain document fragments: never log them.
        stdout: true, stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      timer = setTimeout(() => finish(extractionError('CV_EXTRACTION_TIMEOUT')), timeoutMs);
      worker.once('message', result => finish(result.code ? extractionError(result.code) : null, result.text));
      worker.once('error', () => finish(extractionError('CV_EXTRACTION_FAILED')));
      worker.once('exit', () => finish(extractionError('CV_EXTRACTION_FAILED')));
    } catch (_) { finish(extractionError('CV_EXTRACTION_FAILED')); }
  });
}
function sendCvError(res, error) {
  const known = MESSAGES[error.code];
  const tooLarge = error.status === 413;
  return res.status(known ? error.status : tooLarge ? 413 : error.status === 502 ? 502 : 503).json({
    code: known ? error.code : tooLarge ? 'CV_FILE_TOO_LARGE' : 'CV_STORAGE_UNAVAILABLE',
    error: known || (tooLarge ? MESSAGES.CV_FILE_TOO_LARGE : 'Le document ne peut pas être lu ou enregistré pour le moment. Réessayez ; vous pouvez aussi coller le texte du CV.'),
  });
}
module.exports = { extractPdfText, extractionError, textState, sendCvError };
