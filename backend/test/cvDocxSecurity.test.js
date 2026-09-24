const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { docx, CV_TEXT } = require('./fixtures/cvDocuments');
const { extractDocxText: boundedText, readEntries, LIMITS } = require('../utils/cvDocxText');
const { extractDocxText } = require('../utils/cvExtraction');
const { textState } = require('../utils/cvExtraction');
const normalized = text => text.replace(/\s+/g, ' ').trim();
test('DOCX and PDF share concurrency slots, and DOCX timeout releases its slot', async () => {
  const { extractPdfText } = require('../utils/cvExtraction');
  const buffer = docx(CV_TEXT, true);
  const first = extractDocxText(buffer);
  const second = extractDocxText(buffer);
  await assert.rejects(extractPdfText(Buffer.from('%PDF-')), { code: 'CV_EXTRACTION_BUSY' });
  await Promise.all([first, second]);
  await assert.rejects(extractDocxText(buffer, { timeoutMs: 1 }), { code: 'CV_EXTRACTION_TIMEOUT' });
  assert.equal(normalized(await extractDocxText(buffer)), CV_TEXT);
});
for (const compressed of [false, true]) {
  test(`normal DOCX remains readable (compressed=${compressed})`, async () => {
    assert.equal(normalized(await extractDocxText(docx(CV_TEXT, compressed))), CV_TEXT);
  });
}
test('DOCX close to per-entry ceiling is extracted intact off the Express thread', async () => {
  const text = randomBytes(750000).toString('base64');
  const buffer = docx(text, true);
  let tick = false;
  setImmediate(() => { tick = true; });
  const result = normalized(await extractDocxText(buffer));
  assert.equal(tick, true);
  assert.equal(result, text);
  assert.equal(textState(result, 'large.docx').code, 'CV_TEXT_TOO_LONG');
});
test('review ZIP bomb is rejected by metadata alone before decompression', async t => {
  const buffer = docx('A'.repeat(16 * 1024 * 1024), true);
  const start = performance.now();
  // readEntries never invokes zlib. This rejection allocates no expanded XML.
  assert.throws(() => readEntries(buffer), { code: 'CV_DOCX_LIMIT' });
  await assert.rejects(extractDocxText(buffer), { code: 'CV_DOCX_LIMIT' });
  t.diagnostic(JSON.stringify({ compressed_bytes: buffer.length, announced_bytes: 16 * 1024 * 1024, rejected_ms: Math.round(performance.now() - start) }));
  assert.equal(normalized(await extractDocxText(docx(CV_TEXT, true))), CV_TEXT);
});
test('lying ZIP sizes cannot bypass the effective zlib output ceiling', async () => {
  const buffer = docx('A'.repeat(16 * 1024 * 1024), true);
  const central = buffer.readUInt32LE(buffer.length - 22 + 16);
  buffer.writeUInt32LE(100000, 22);
  buffer.writeUInt32LE(100000, central + 24);
  assert.equal(readEntries(buffer)[0].size, 100000); // deliberately passes metadata checks
  assert.throws(() => boundedText(buffer), { code: 'CV_DOCX_LIMIT' });
  await assert.rejects(extractDocxText(buffer), { code: 'CV_DOCX_LIMIT' });
});
test('excessive ratio, truncated ZIP, encryption and invalid offsets fail safely', async () => {
  await assert.rejects(extractDocxText(docx('x'.repeat(300000), true)), { code: 'CV_DOCX_LIMIT' });
  const valid = docx(CV_TEXT, true);
  await assert.rejects(extractDocxText(valid.subarray(0, valid.length - 5)), { code: 'CV_DOCX_INVALID' });
  const encrypted = Buffer.from(valid);
  const central = encrypted.readUInt32LE(encrypted.length - 6);
  encrypted.writeUInt16LE(1, central + 8);
  await assert.rejects(extractDocxText(encrypted), { code: 'CV_DOCX_INVALID' });
  const invalid = Buffer.from(valid);
  invalid.writeUInt32LE(0xffffffff, central + 42);
  await assert.rejects(extractDocxText(invalid), { code: 'CV_DOCX_INVALID' });
});
test('aggregate XML limit and directory entry limit are checked before inflating', () => {
  const original = docx(randomBytes(300000).toString('base64'), true);
  const centralStart = original.readUInt32LE(original.length - 6);
  const entry = original.subarray(centralStart, original.length - 22);
  const directories = [];
  // All entries point at the same data. The total-size rejection happens before inflation.
  // Names and local headers must match, so use separate complete ZIP local records.
  const locals = [];
  let offset = 0;
  for (let i = 0; i < 11; i++) {
    const local = Buffer.from(original.subarray(0, centralStart));
    const directory = Buffer.from(entry);
    const name = i ? `word/header${String(i).padStart(2, '0')}.xml` : 'word/document.xml';
    assert.equal(Buffer.byteLength(name), 17);
    local.write(name, 30); directory.write(name, 46);
    directory.writeUInt32LE(offset, 42);
    locals.push(local); directories.push(directory); offset += local.length;
  }
  const end = Buffer.from(original.subarray(original.length - 22));
  end.writeUInt16LE(11, 8); end.writeUInt16LE(11, 10);
  end.writeUInt32LE(directories.reduce((n,b) => n+b.length,0), 12); end.writeUInt32LE(offset, 16);
  assert.throws(() => readEntries(Buffer.concat([...locals, ...directories, end])), { code: 'CV_DOCX_LIMIT' });
  end.writeUInt16LE(LIMITS.entries + 1, 8); end.writeUInt16LE(LIMITS.entries + 1, 10);
  assert.throws(() => readEntries(Buffer.concat([...locals, ...directories, end])), { code: 'CV_DOCX_LIMIT' });
});
