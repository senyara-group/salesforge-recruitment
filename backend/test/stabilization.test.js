const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const aiRouter = require('../routes/ai');
const candidateRouter = require('../routes/candidats');
const { owned, ownedById, ownedConversationMessages, withOwner } = require('../utils/ownership');

function storedDocx(text) {
  const name = Buffer.from('word/document.xml');
  const data = Buffer.from(`<w:document><w:p><w:t>${text}</w:t></w:p></w:document>`);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

test('legacy random analysis and hot-candidate routes are not mounted', () => {
  const paths = aiRouter.stack.map((layer) => layer.route?.path).filter(Boolean);
  assert.equal(paths.includes('/analyse'), false);
  assert.equal(paths.includes('/hot-candidate'), false);
  assert.equal(paths.includes('/score-adn'), true);
});

test('fictitious PDF, DOCX and DOC fixtures have valid signatures and extract text', () => {
  const { validateProfileDocument, extractCvText } = candidateRouter._test;
  const fixtures = [
    { filename: 'fictif.pdf', buffer: Buffer.from('%PDF-1.4\nBT (Candidate fictif commercial B2B avec experience de prospection) Tj ET\n%%EOF') },
    { filename: 'fictif.docx', buffer: storedDocx('Candidate fictif commercial B2B avec experience de prospection') },
    { filename: 'fictif.doc', buffer: Buffer.concat([Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]), Buffer.from(' Candidate fictif commercial B2B avec experience de prospection')]) },
  ];
  for (const fixture of fixtures) {
    assert.doesNotThrow(() => validateProfileDocument(fixture));
    assert.match(extractCvText(fixture), /Candidate fictif/i);
  }
});

test('falsified and malformed CV extensions are rejected before storage', () => {
  const { validateProfileDocument } = candidateRouter._test;
  for (const filename of ['faux.pdf', 'faux.doc', 'faux.docx']) {
    assert.throws(() => validateProfileDocument({ filename, buffer: Buffer.from('not a document') }), /invalide|extension/i);
  }
  assert.throws(() => validateProfileDocument({ filename: 'archive.docx', buffer: Buffer.from('PK\x03\x04broken') }), /invalide/i);
});

function queryRecorder() {
  const filters = [];
  return { filters, eq(column, value) { filters.push([column, value]); return this; } };
}

test('ownership helpers always scope arbitrary AI resource identifiers to JWT user', () => {
  const analysis = ownedById(queryRecorder(), 'user-a', 'analysis-b');
  assert.deepEqual(analysis.filters, [['id', 'analysis-b'], ['user_id', 'user-a']]);
  const conversation = ownedById(queryRecorder(), 'user-a', 'conversation-b');
  assert.deepEqual(conversation.filters, [['id', 'conversation-b'], ['user_id', 'user-a']]);
  const messages = ownedConversationMessages(queryRecorder(), 'user-a', 'conversation-b');
  assert.deepEqual(messages.filters, [['conversation_id', 'conversation-b'], ['user_id', 'user-a']]);
  assert.deepEqual(owned(queryRecorder(), 'user-a').filters, [['user_id', 'user-a']]);
});

test('JWT owner overrides any user_id supplied by the client body', () => {
  assert.deepEqual(withOwner({ user_id: 'user-b', content: 'fictif' }, 'user-a'), { user_id: 'user-a', content: 'fictif' });
});
