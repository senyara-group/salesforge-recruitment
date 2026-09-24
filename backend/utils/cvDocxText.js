const { inflateRawSync } = require('node:zlib');

const LIMITS = Object.freeze({ entryBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, ratio: 200, entries: 512 });
function failure(code = 'CV_DOCX_INVALID') { return Object.assign(new Error(code), { code }); }
function checkRange(buffer, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > buffer.length) throw failure();
}
function readEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { eocd = i; break; }
  }
  if (eocd < 0 || buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6)) throw failure();
  const count = buffer.readUInt16LE(eocd + 10);
  if (count !== buffer.readUInt16LE(eocd + 8)) throw failure();
  if (count > LIMITS.entries) throw failure('CV_DOCX_LIMIT');
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryStart = buffer.readUInt32LE(eocd + 16);
  if (directoryStart + directorySize !== eocd) throw failure();
  const entries = [];
  const names = new Set();
  let cursor = directoryStart;
  let total = 0;
  for (let i = 0; i < count; i++) {
    checkRange(buffer, cursor, 46);
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw failure();
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const packed = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    if (next > eocd) throw failure();
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name === 'word/document.xml' || /^word\/(header|footer)\d*\.xml$/.test(name)) {
      if (names.has(name) || flags & 1 || ![0, 8].includes(method)) throw failure();
      names.add(name);
      total += size;
      if (size > LIMITS.entryBytes || total > LIMITS.totalBytes || size > Math.max(packed, 1) * LIMITS.ratio) throw failure('CV_DOCX_LIMIT');
      const local = buffer.readUInt32LE(cursor + 42);
      checkRange(buffer, local, 30);
      if (buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 8) !== method || buffer.readUInt16LE(local + 6) !== flags) throw failure();
      const localNameLength = buffer.readUInt16LE(local + 26);
      checkRange(buffer, local + 30, localNameLength);
      if (buffer.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name) throw failure();
      const start = local + 30 + localNameLength + buffer.readUInt16LE(local + 28);
      checkRange(buffer, start, packed);
      if (start + packed > directoryStart) throw failure();
      if (!(flags & 8) && (buffer.readUInt32LE(local + 18) !== packed || buffer.readUInt32LE(local + 22) !== size)) throw failure();
      entries.push({ start, packed, size, method });
    }
    cursor = next;
  }
  if (cursor !== eocd || !names.has('word/document.xml')) throw failure();
  return entries;
}
function extractDocxText(buffer) {
  // Validate *all* relevant directory entries before allocating decompressed data.
  const entries = readEntries(buffer);
  let total = 0;
  const texts = [];
  for (const entry of entries) {
    const compressed = buffer.subarray(entry.start, entry.start + entry.packed);
    // Metadata is untrusted: zlib enforces the effective output ceiling as well.
    const ceiling = Math.min(LIMITS.entryBytes, LIMITS.totalBytes - total, Math.max(entry.packed, 1) * LIMITS.ratio);
    let raw;
    try { raw = entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(entry.size, ceiling)) }) : compressed; }
    catch (error) { throw failure(error.code === 'ERR_BUFFER_TOO_LARGE' ? 'CV_DOCX_LIMIT' : 'CV_DOCX_INVALID'); }
    total += raw.length;
    if (raw.length > ceiling || total > LIMITS.totalBytes) throw failure('CV_DOCX_LIMIT');
    if (raw.length !== entry.size) throw failure();
    texts.push(raw.toString('utf8').replace(/<w:tab\/>/g, ' ').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  }
  return texts.join('\n');
}
module.exports = { LIMITS, readEntries, extractDocxText };
