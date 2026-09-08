import { readFileSync } from 'node:fs';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { z } from 'zod';
import { imageSize, fit, drawing, attach } from './images.js';

const catalog = JSON.parse(readFileSync(new URL('../templates/catalog.json', import.meta.url), 'utf8'));
export const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// Reject characters that XML 1.0 cannot contain. Content is always escaped, never executed.
const text = (max) => z.string().trim().max(max).regex(/^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]*$/u, 'Texten innehåller otillåtna kontrolltecken.');
const section = z.object({ heading: text(200).optional(), text: text(40000).min(1) }).strict();
export const reportShape = {
  report_type: text(150).optional().describe('Mallens id från list_templates. Saknad eller okänd typ använder standardmallen skola.'),
  title: text(250).min(1).describe('Den nya rapportens titel. Ersätter alltid mallens titel.'),
  report_text: text(120000).optional().describe('Hela färdiga rapporttexten, utan brevhuvud och titel. Enkel Markdown: # rubrik, - punktlista, **fet stil** och [text](adress) som blir klickbar länk. Skicka antingen report_text eller sections.'),
  sections: z.array(section).min(1).max(60).optional().describe('Ordnade avsnitt med heading och text. Alternativ till report_text.'),
  report_date: text(40).optional(),
  case_number: text(100).optional(),
  inspector: text(150).optional(),
  food_summary: z.object({
    passed: text(2000),
    follow_up: text(2000),
    deviations: text(2000)
  }).strict().optional().describe('Endast livsmedel: text till originalmallens tabell med Kontrollerat utan avvikelser, Uppföljning av tidigare avvikelser och Avvikelser. Utelämna fältet helt för alla andra rapporttyper. Skicka endast verifierade uppgifter. Tom sträng lämnar respektive fält tomt i livsmedelsmallen.'),
  recipient: text(1200).optional().describe('Mottagare och eventuell adress, med radbrytningar. Högst 8 rader.'),
  metadata: z.array(z.object({ label: text(80).min(1), value: text(800).min(1) }).strict()).max(20).optional().describe('Uppgifter under titeln, exempelvis Verksamhet, Org. nr, Fastighet, Inspektionsdatum och Närvarande.'),
  images: z.array(z.object({
    data: z.string().min(1).max(12000000).describe('Fotot som base64, med eller utan data:-prefix. PNG eller JPEG.'),
    caption: text(600).optional().describe('Bildtext. Beskriv endast det som tydligt syns.')
  }).strict()).max(20).optional().describe('Foton till fotobilagan, som levereras som ett eget dokument. Numreras Bild 1, Bild 2 i den ordning de skickas. Rapporten själv innehåller aldrig bilder.')
};
// Ett food_summary med enbart tomma stranger betyder "inte tillämpligt", inte ett fel.
const foodFilled = f => Boolean(f) && Object.values(f).some(v => v && v.trim());
export const reportSchema = z.object(reportShape).strict().superRefine((v, ctx) => {
  if (Boolean(v.report_text) === Boolean(v.sections?.length)) ctx.addIssue({code:'custom', message:'Skicka rapportinnehåll i exakt ett av report_text eller sections.'});
  // Fotona mäts för sig. De är alltid större än texten och skulle annars ensamma spränga taket.
  if (JSON.stringify({...v, images: undefined}).length > 150000) ctx.addIssue({code:'custom',message:'Rapporttexten är för stor. Högst 150 000 tecken utöver foton.'});
  if ((v.recipient?.split('\n').length || 0) > 8) ctx.addIssue({code:'custom',message:'Mottagarblocket får innehålla högst 8 rader.'});
  if (foodFilled(v.food_summary) && selectTemplate(v.report_type).template.id!=='livsmedel') ctx.addIssue({code:'custom',message:'food_summary innehåller uppgifter men rapporttypen är inte livsmedel. Ta bort fältet eller byt rapporttyp.'});
});
const normalize = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const aliases = new Map();
for (const t of catalog) for (const n of [t.id, t.name]) aliases.set(normalize(n), t.id);
for (const [n,id] of Object.entries({'bilskrot':'avfall_bilskrot','energitillsyn':'skola_energi','livsmedelsverksamhet':'livsmedel','livsmedelskontroll':'livsmedel','hygienisk verksamhet':'hygienisk_verksamhet'})) aliases.set(normalize(n),id);
export function selectTemplate(type) {
  const id = aliases.get(normalize(type));
  return { template: catalog.find(t => t.id === (id || 'skola')), fallback: !id };
}
export function listTemplates() { return catalog.map(({id,name,suggested_sections}) => ({id,name,suggested_sections,default:id==='skola'})); }
export const escapeXml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const HYPERLINK_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
// Markdownlänk [text](adress), en naken adress, eller **fetstil**. Endast http och https
// blir klickbara, så att javascript: och liknande scheman aldrig kan hamna i ett dokument.
// Fetstil måste hanteras här: en språkmodell skriver markdown av gammal vana, och utan
// stöd hamnar asteriskerna som synlig text i myndighetsrapporten.
const INLINE_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+)|\*\*(?!\s)([^*\n]+?)\*\*/g;
const breaks = value => escapeXml(value).replace(/\n/g,'</w:t><w:br/><w:t xml:space="preserve">');
// Länkarna samlas under renderingen och skrivs in i document.xml.rels efteråt. En w:hyperlink
// är bara giltig om relationen finns i paketet, så de två stegen hör ihop.
function linkRun(template, links, label, url) {
  const id = 'rIdMcp' + (links.length + 1);
  links.push({ id, url });
  const style = template.link_style ? '<w:rPr><w:rStyle w:val="' + template.link_style + '"/></w:rPr>' : '';
  return '</w:t></w:r><w:hyperlink xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="'
    + id + '"><w:r>' + style + '<w:t xml:space="preserve">' + escapeXml(label)
    + '</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve">';
}
const boldRun = value => '</w:t></w:r><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">'
  + breaks(value) + '</w:t></w:r><w:r><w:t xml:space="preserve">';
function inline(template, content, links) {
  if (!links) return breaks(content);
  let out = '', last = 0, match;
  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(content))) {
    const [full, label, href, bare, bold] = match;
    out += breaks(content.slice(last, match.index));
    out += bold !== undefined ? boldRun(bold) : linkRun(template, links, label || bare, href || bare);
    last = match.index + full.length;
  }
  return out + breaks(content.slice(last));
}
function paragraph(template, kind, content, links) {
  return template.prototypes[kind].replace('__TEXT__', () => inline(template, content, links));
}
// Punktprototypen är hämtad ur originalrapporten av scripts/extract-prototypes.js, så
// indrag och numrering blir exakt originalets. Somliga mallar sätter ett eget numId,
// andra ärver punkten från stildefinitionen; skillnaden är avsiktlig och bevaras.
// Livsmedelsmallen saknar punktlistor helt och faller tillbaka på tecknet.
function bullet(template, content, links) {
  if (template.prototypes.bullet) return paragraph(template, 'bullet', content, links);
  if (!template.bullet_style) return paragraph(template, 'paragraph', '• ' + content, links);
  return template.prototypes.paragraph
    .replace('<w:r>', '<w:pPr><w:pStyle w:val="' + template.bullet_style + '"/></w:pPr><w:r>')
    .replace('__TEXT__', () => inline(template, content, links));
}
function bodyText(template, textValue, links) {
  const lines = textValue.replace(/\r\n?/g,'\n').split('\n');
  let buffer=[]; const out=[];
  const flush=()=>{ if(buffer.length) {out.push(paragraph(template,'paragraph',buffer.join('\n'),links)); buffer=[];} };
  for(const line of lines) {
    const heading=line.match(/^#{1,6}\s+(.+)$/);
    if(heading) { flush(); out.push(paragraph(template,'heading',heading[1],links)); }
    else if(/^\s*[-*]\s+/.test(line)) {flush(); out.push(bullet(template,line.replace(/^\s*[-*]\s+/,''),links));}
    else if(!line.trim()) flush();
    else buffer.push(line);
  }
  flush(); return out.join('');
}
export function generateReport(input) {
  const data=reportSchema.parse(input);
  const {template,fallback}=selectTemplate(data.report_type);
  const warnings=[];
  if(fallback) warnings.push('Rapporttypen saknas eller matchar ingen mall. Standardmallen Skola används med den angivna titeln.');
  const missing=['report_date','case_number','inspector','recipient'].filter(k=>!data[k]);
  if(missing.length) warnings.push(`Följande uppgifter saknas och lämnas tomma: ${missing.join(', ')}.`);
  const links=[];
  let xml=(data.metadata || []).map(m=>paragraph(template,'metadata',`${m.label}: ${m.value}`)).join('');
  if(data.food_summary && template.id!=='livsmedel') warnings.push('food_summary ignorerades: fältet är tomt och rapporttypen är inte livsmedel.');
  if(data.food_summary && template.id==='livsmedel') {
    xml+=template.prototypes.food_summary.replace(/__PASSED__|__FOLLOWUP__|__DEVIATIONS__/g,slot=>escapeXml(data.food_summary[{__PASSED__:'passed',__FOLLOWUP__:'follow_up',__DEVIATIONS__:'deviations'}[slot]]).replace(/\n/g,'</w:t><w:br/><w:t xml:space="preserve">'));
  }
  if(data.sections) xml+=data.sections.map(s=>(s.heading?paragraph(template,'heading',s.heading,links):'')+bodyText(template,s.text,links)).join('');
  else xml+=bodyText(template,data.report_text,links);
  const slug=(value)=>(normalize(value).replace(/ /g,'-').slice(0,100)||'inspektionsrapport')+'.docx';
  const buffer=render(template,data,xml,links,[]);
  const photos=decodeImages(data.images,warnings);
  const appendix=photos.length?{buffer:renderAppendix(template,data,photos),filename:slug('Fotobilaga '+data.title)}:null;
  return {buffer,filename:slug(data.title),template_id:template.id,fallback_used:fallback,warnings,appendix,image_count:photos.length};
}
function render(template,data,bodyXml,links,photos) {
  const source=readFileSync(new URL(`../templates/${template.file}`,import.meta.url));
  const doc=new Docxtemplater(new PizZip(source),{paragraphLoop:true,linebreaks:true,nullGetter:()=>'',errorLogging:false});
  doc.render({title:data.title,report_date:data.report_date||'',case_number:data.case_number||'',inspector:data.inspector||'',recipient:data.recipient||'',report_body:bodyXml});
  const zip=doc.getZip();
  if(links.length) {
    const relsPath='word/_rels/document.xml.rels';
    const added=links.map(l=>`<Relationship Id="${l.id}" Type="${HYPERLINK_REL}" Target="${escapeXml(l.url)}" TargetMode="External"/>`).join('');
    zip.file(relsPath, zip.file(relsPath).asText().replace('</Relationships>', added+'</Relationships>'));
  }
  attach(zip,photos);
  return zip.generate({type:'nodebuffer',compression:'DEFLATE'});
}
// Ett trasigt foto far aldrig falla hela rapporten. Det utelamnas och redovisas som varning.
function decodeImages(list,warnings) {
  const photos=[];
  for(const [index,item] of (list||[]).entries()) {
    const raw=item.data.replace(/^data:[^;,]*;base64,/,'').replace(/\s+/g,'');
    let buffer;
    try { buffer=Buffer.from(raw,'base64'); } catch { buffer=null; }
    const size=buffer&&buffer.length?imageSize(buffer):null;
    if(!size) { warnings.push(`Bild ${index+1} kunde inte läsas och utelämnades. Endast PNG och JPEG stöds.`); continue; }
    const number=photos.length+1;
    photos.push({...size,buffer,caption:item.caption,number,
      id:`mcpbild${number}`,relationId:`rIdMcpBild${number}`,...fit(size.width,size.height)});
  }
  return photos;
}
function renderAppendix(template,data,photos) {
  const xml=paragraph(template,'heading','Fotobilaga')
    +photos.map(p=>drawing(p.relationId,p.number,p.cx,p.cy,p.caption)
      +paragraph(template,'paragraph',`Bild ${p.number}.${p.caption?' '+p.caption:''}`)).join('');
  return render(template,{...data,title:'Fotobilaga '+data.title},xml,[],photos);
}
