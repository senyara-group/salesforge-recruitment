// Real PDFs produced by PDFKit (xref, page tree, fonts and streams), not pseudo-PDF strings.
const PDFDocument = require('pdfkit');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { deflateRawSync, crc32 } = require('node:zlib');

const CV_TEXT = 'Élodie Martin — expérience commerciale, négociation et fidélisation. Développement du portefeuille B2B à Lyon. Résultats : 105 % des objectifs annuels. Formation et accompagnement des équipes. Prospection, qualification, démonstrations et suivi client.';
function pdf({ pages = [CV_TEXT], compress = true, embeddedFont = false, password, imageBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ compress, userPassword: password, ownerPassword: password ? 'owner-fixture' : undefined });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    if (embeddedFont) doc.font(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts/LiberationSans-Regular.ttf'));
    pages.forEach((text, i) => { if (i) doc.addPage(); if (text) doc.text(text); });
    if (imageBytes) {
      const width = 1600;
      const height = Math.ceil(imageBytes / (width * 3));
      const image = doc.ref({ Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
      image.end(randomBytes(width * height * 3));
      doc.page.xobjects.FixtureImage = image;
      doc.addContent('q 200 0 0 200 72 72 cm /FixtureImage Do Q');
    }
    doc.end();
  });
}
function docx(text, compressed = false) {
  const name = Buffer.from('word/document.xml');
  const raw = Buffer.from(`<w:document><w:p><w:t>${text}</w:t></w:p></w:document>`);
  const data = compressed ? deflateRawSync(raw) : raw;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(compressed ? 8 : 0, 8);
  local.writeUInt32LE(crc32(raw), 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6); central.writeUInt16LE(compressed ? 8 : 0, 10);
  central.writeUInt32LE(crc32(raw), 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}
module.exports = { CV_TEXT, pdf, docx };
