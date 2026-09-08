// Återställer logotypens vektorversion i mallarna.
//
// Word bäddar in logotypen som SVG med en PNG som reserv för äldre versioner. När mallarna
// förbereddes ströks SVG-referensen och kvar blev <a:extLst/>, en tom tillägglista. Följden
// är att Word renderar den 12 kB stora bitmappen i stället för vektorn, vilket syns vid
// utskrift och inzoomning. Skriptet hämtar tillbaka SVG:en ur originalrapporterna.
//
//   node scripts/restore-logo-svg.js "C:/Users/zq8965/Downloads"
//
// Mallarna checkas in färdiga, så bygget aldrig beror på att originalen finns lokalt.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import PizZip from 'pizzip';

const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const SVG_ID = 'rIdLogoSvg';
const EXT_URI = '{96DAC541-7B7A-43D3-8B79-37D633B846F1}';
const SVG_NS = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main';
const extLst = `<a:extLst><a:ext uri="${EXT_URI}"><asvg:svgBlip xmlns:asvg="${SVG_NS}" r:embed="${SVG_ID}"/></a:ext></a:extLst>`;

const sources = {
  avfall: 'Inspektionsrapport färdig Avfallsverksamhet.docx',
  avfall_bilskrot: 'Inspektionsrapport färdig Avfallsverksamhet bilskrot.docx',
  forskola: 'Inspektionsrapport färdig Förskola.docx',
  livsmedel: 'Inspektionsrapport färdig med avvikelse_Livsmedelsverksamhet.docx',
  skola: 'Inspektionsrapport färdig Skola.docx',
  skola_energi: 'Inspektionsrapport färdig Skola energitillsyn.docx',
  solarium: 'Inspektionsrapport färdig Solarium.docx',
  hygienisk_verksamhet: 'Inspektionsrapport färdig Yrkesmässig hygienisk verksamhet.docx'
};

const dir = process.argv[2];
if (!dir) throw new Error('Ange katalogen med originalrapporterna som argument.');
const catalog = JSON.parse(readFileSync(new URL('../templates/catalog.json', import.meta.url), 'utf8'));

// Alla mallar bär samma kommunlogotyp, så en SVG som hittas duger åt alla.
let svg = null;
for (const name of Object.values(sources)) {
  const file = join(dir, name);
  if (!existsSync(file)) continue;
  const zip = new PizZip(readFileSync(file));
  const entry = Object.keys(zip.files).find(f => f.endsWith('.svg'));
  if (entry) { svg = zip.file(entry).asNodeBuffer(); break; }
}
if (!svg) throw new Error('Hittade ingen SVG i originalrapporterna.');
console.log(`SVG hämtad: ${svg.length} bytes, sha1 ${createHash('sha1').update(svg).digest('hex').slice(0, 16)}\n`);

for (const template of catalog) {
  const path = new URL(`../templates/${template.file}`, import.meta.url);
  const zip = new PizZip(readFileSync(path));
  let doc = zip.file('word/document.xml').asText();
  const atgardat = [];

  // Logotypen är ett flytande objekt. I originalen ligger den bakom textlagret; i mallarna
  // hamnade den framför, så den lade sig över innehållet i stället för under.
  if (/<wp:anchor[^>]*behindDoc="0"/.test(doc)) {
    doc = doc.replace(/(<wp:anchor[^>]*?)behindDoc="0"/, '$1behindDoc="1"');
    atgardat.push('flyttad bakom texten');
  }

  if (!doc.includes('svgBlip') && doc.includes('<a:extLst/>')) {
    zip.file('word/media/image2.svg', svg);
    doc = doc.replace('<a:extLst/>', extLst);
    atgardat.push('SVG återställd');
  }

  zip.file('word/document.xml', doc);
  if (!atgardat.length) { console.log(`${template.id.padEnd(22)} redan korrekt`); continue; }

  const relsPath = 'word/_rels/document.xml.rels';
  const rels = zip.file(relsPath).asText();
  if (!rels.includes(SVG_ID)) {
    zip.file(relsPath, rels.replace('</Relationships>',
      `<Relationship Id="${SVG_ID}" Type="${IMAGE_REL}" Target="media/image2.svg"/></Relationships>`));
  }

  // Utan en deklaration för svg vägrar Word öppna paketet.
  const typesPath = '[Content_Types].xml';
  const types = zip.file(typesPath).asText();
  if (!/Extension="svg"/.test(types)) {
    zip.file(typesPath, types.replace('<Default ',
      '<Default Extension="svg" ContentType="image/svg+xml"/><Default ', 1));
  }

  writeFileSync(path, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
  console.log(`${template.id.padEnd(22)} ${atgardat.join(', ')}`);
}
