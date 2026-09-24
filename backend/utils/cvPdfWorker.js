const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');

(async () => {
  let task;
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
    task = getDocument({
      data: workerData,
      isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
      stopAtErrors: true, verbosity: 0,
      cMapUrl: path.join(root, 'cmaps') + '/', cMapPacked: true,
      standardFontDataUrl: path.join(root, 'standard_fonts') + '/',
      wasmUrl: path.join(root, 'wasm') + '/',
    });
    const document = await task.promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items.filter(item => typeof item.str === 'string')
        .map(item => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
      page.cleanup();
    }
    parentPort.postMessage({ text: pages.join('\n') });
  } catch (error) {
    parentPort.postMessage({ code: error.name === 'PasswordException' ? 'CV_PDF_PROTECTED'
      : ['InvalidPDFException', 'FormatError', 'UnknownErrorException'].includes(error.name) ? 'CV_PDF_INVALID' : 'CV_EXTRACTION_FAILED' });
  } finally {
    if (task) await task.destroy().catch(() => {});
  }
})();
