const test = require('node:test');
const assert = require('node:assert/strict');
const { CV_TEXT, pdf, docx } = require('./fixtures/cvDocuments');
const { extractPdfText, textState, sendCvError } = require('../utils/cvExtraction');
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';
const { extractCvText, MAX_CV_BYTES } = require('../routes/candidats')._test;
const extract = buffer => extractCvText({ filename: 'cv.pdf', buffer });

for (const compress of [false, true]) {
  test(`real PDF, compressed=${compress}: only real text, accents preserved, original intact`, async () => {
    const buffer = await pdf({ compress });
    const original = Buffer.from(buffer);
    if (compress) assert.ok(buffer.includes(Buffer.from('/FlateDecode')));
    const text = await extract(buffer);
    assert.equal(text.replace(/\s+/g, ' '), CV_TEXT);
    assert.equal(textState(text, 'cv.pdf').readable, true);
    assert.ok(text.length < 30000);
    assert.doesNotMatch(text, /%PDF|endobj|FlateDecode|xref|stream|\u0000/);
    assert.deepEqual(buffer, original);
  });
}
test('multipage compressed PDF with embedded font and Unicode mapping', async () => {
  const buffer = await pdf({ embeddedFont: true, pages: [CV_TEXT, 'Deuxième page : compétences, marchés européens, cœur de métier.'] });
  assert.ok(buffer.includes(Buffer.from('/FontFile2')));
  const text = await extract(buffer);
  assert.match(text, /Élodie Martin/);
  assert.match(text, /Deuxième page : compétences, marchés européens, cœur de métier/);
});
test('image-only PDF has no text and is not readable', async () => {
  const text = await extract(await pdf({ pages: [''], imageBytes: 300000 }));
  assert.equal(text, '');
  assert.equal(textState(text, 'scan.pdf').readable, false);
  assert.match(textState(text, 'scan.pdf').message, /scanné|images/);
});
test('invalid, truncated and protected PDFs fail explicitly, never return binary content', async () => {
  for (const buffer of [Buffer.from('not a PDF'), Buffer.from('%PDF-1.7\n(BINARY FAKE TEXT)\n'.repeat(1000)), (await pdf()).subarray(0, 100)]) {
    await assert.rejects(extract(buffer), { code: 'CV_PDF_INVALID' });
  }
  await assert.rejects(extract(await pdf({ password: 'secret' })), { code: 'CV_PDF_PROTECTED' });
});
test('legacy DOC is explicitly unsupported and DOCX stored/deflated remain intact', async () => {
  await assert.rejects(extractCvText({ filename: 'old.doc', buffer: Buffer.from('fake UTF16 and latin1 CV') }), { code: 'CV_LEGACY_DOC' });
  for (const compressed of [false, true]) {
    assert.equal(await extractCvText({ filename: 'cv.docx', buffer: docx(CV_TEXT, compressed) }), CV_TEXT);
  }
});
test('true text above 30k is preserved with exact length and actionable state', async () => {
  const text = await extract(await pdf({ pages: Array.from({ length: 130 }, () => CV_TEXT) }));
  assert.ok(text.length > 30000);
  assert.equal(text.split('Élodie Martin').length - 1, 130);
  const state = textState(text, 'long.pdf');
  assert.equal(state.readable, true);
  assert.equal(state.analysable, false);
  assert.match(state.message, new RegExp(String(text.length)));
  assert.match(state.message, /30 000|concise/);
});
test('near 8 MiB real image-heavy PDF: short extracted text, bounded runtime', async t => {
  const buffer = await pdf({ imageBytes: 8 * 1024 * 1024 - 50000 });
  assert.ok(buffer.length > 7.9 * 1024 * 1024 && buffer.length <= MAX_CV_BYTES);
  const start = performance.now();
  const rss = process.memoryUsage().rss;
  const text = await extract(buffer);
  const elapsed = Math.round(performance.now() - start);
  assert.equal(text.replace(/\s+/g, ' '), CV_TEXT);
  assert.ok(elapsed < 30000);
  t.diagnostic(JSON.stringify({ bytes: buffer.length, chars: text.length, elapsed_ms: elapsed, rss_delta_mb: Math.round((process.memoryUsage().rss - rss) / 1024 / 1024) }));
  await assert.rejects(extract(Buffer.alloc(MAX_CV_BYTES + 1)), { code: 'CV_FILE_TOO_LARGE' });
});
test('extraction deadline terminates work and permits the next extraction', async () => {
  const buffer = await pdf();
  await assert.rejects(extractPdfText(buffer, { timeoutMs: 1 }), { code: 'CV_EXTRACTION_TIMEOUT' });
  assert.equal((await extract(buffer)).replace(/\s+/g, ' '), CV_TEXT);
});
test('concurrent PDF work is bounded and saturation is explicit', async () => {
  const buffer = await pdf();
  const first = extract(buffer);
  const second = extract(buffer);
  await assert.rejects(extract(buffer), { code: 'CV_EXTRACTION_BUSY' });
  const results = await Promise.all([first, second]);
  assert.ok(results.every(text => text.replace(/\s+/g, ' ') === CV_TEXT));
});
test('public storage errors never expose internal details', () => {
  const res = { status(value) { this.value = value; return this; }, json(body) { this.body = body; return this; } };
  sendCvError(res, new Error('Supabase secret connection trace'));
  assert.equal(res.value, 503);
  assert.equal(res.body.code, 'CV_STORAGE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(res.body), /Supabase|secret|trace/);
});
