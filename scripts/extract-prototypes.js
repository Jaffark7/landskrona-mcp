// Hämtar styckeprototyper ur de färdigskrivna originalrapporterna och skriver in dem
// i templates/catalog.json. Originalen är facit för hur ett stycke ska se ut: rubrikernas
// automatnumrering och punktlistans indrag ligger i deras w:pPr, inte i stildefinitionen.
//
// Körs manuellt när mallarna ändras:
//   node scripts/extract-prototypes.js "C:/Users/zq8965/Downloads"
//
// Resultatet checkas in, så bygget aldrig beror på att originalen finns kvar lokalt.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import PizZip from 'pizzip';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const catalogPath = new URL('../templates/catalog.json', import.meta.url);
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

// Filnamnen på originalen som varje mall är gjord av.
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

function paragraphs(file) {
  const xml = new PizZip(readFileSync(file)).file('word/document.xml').asText();
  const body = xml.slice(xml.indexOf('<w:body>'));
  return body.split(/(?=<w:p[ >])/).filter(b => b.startsWith('<w:p')).map(block => ({
    style: (block.match(/w:pStyle w:val="([^"]+)"/) || [])[1] || '',
    pPr: (block.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [])[0] || '',
    text: (block.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('')
  }));
}

// Styckemarkörens egna teckenegenskaper hör till originalets innehåll, inte till formatet.
const clean = pPr => pPr.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '');
const wrap = pPr => `<w:p xmlns:w="${W}">${clean(pPr)}<w:r><w:t xml:space="preserve">__TEXT__</w:t></w:r></w:p>`;

let changed = 0;
for (const template of catalog) {
  const name = sources[template.id];
  const file = name && join(dir, name);
  if (!file || !existsSync(file)) { console.log(`${template.id.padEnd(22)} original saknas, hoppas över`); continue; }

  const paras = paragraphs(file);
  // Somliga mallar numrerar rubrikerna via w:numPr, andra inte. Ta ett numrerat stycke när
  // det finns, annars det första vanliga - båda är giltiga och skillnaden är avsiktlig.
  const rubriker = paras.filter(p => p.style === 'Rubrik1');
  const heading = rubriker.find(p => p.pPr.includes('<w:numPr>')) || rubriker[0];
  // numId 0 stänger av punkten på just det stycket och används för indragen brödtext.
  // Ett stycke helt utan w:numPr ärver punkten från stildefinitionen och är också korrekt.
  const punkter = paras.filter(p => p.style === 'Punktlista');
  const bullet = punkter.find(p => p.pPr.includes('<w:numPr>') && !/<w:numId w:val="0"\/>/.test(p.pPr))
    || punkter.find(p => !p.pPr.includes('<w:numPr>'));

  const before = JSON.stringify(template.prototypes);
  if (heading) template.prototypes.heading = wrap(heading.pPr);
  if (bullet) template.prototypes.bullet = wrap(bullet.pPr);
  if (JSON.stringify(template.prototypes) !== before) changed++;

  const numId = p => (p?.pPr.match(/<w:numId w:val="(\d+)"\/>/) || [])[1] || '-';
  console.log(`${template.id.padEnd(22)} rubrik numId ${String(numId(heading)).padEnd(4)} punkt numId ${numId(bullet)}`);
}

writeFileSync(catalogPath, JSON.stringify(catalog, null, 1));
console.log(`\n${changed} mallar uppdaterade i templates/catalog.json`);
