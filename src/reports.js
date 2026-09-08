import { readFileSync } from 'node:fs';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { z } from 'zod';

const catalog = JSON.parse(readFileSync(new URL('../templates/catalog.json', import.meta.url), 'utf8'));
export const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// Reject characters that XML 1.0 cannot contain. Content is always escaped, never executed.
const text = (max) => z.string().trim().max(max).regex(/^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]*$/u, 'Texten innehåller otillåtna kontrolltecken.');
const section = z.object({ heading: text(200).optional(), text: text(40000).min(1) }).strict();
export const reportShape = {
  report_type: text(150).optional().describe('Mallens id från list_templates. Saknad eller okänd typ använder standardmallen skola.'),
  title: text(250).min(1).describe('Den nya rapportens titel. Ersätter alltid mallens titel.'),
  report_text: text(120000).optional().describe('Hela färdiga rapporttexten, utan brevhuvud och titel. Enkel Markdown med # rubriker och - listor stöds. Skicka antingen report_text eller sections.'),
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
  metadata: z.array(z.object({ label: text(80).min(1), value: text(800).min(1) }).strict()).max(20).optional().describe('Uppgifter under titeln, exempelvis Verksamhet, Org. nr, Fastighet, Inspektionsdatum och Närvarande.')
};
// Ett food_summary med enbart tomma stranger betyder "inte tillämpligt", inte ett fel.
const foodFilled = f => Boolean(f) && Object.values(f).some(v => v && v.trim());
export const reportSchema = z.object(reportShape).strict().superRefine((v, ctx) => {
  if (Boolean(v.report_text) === Boolean(v.sections?.length)) ctx.addIssue({code:'custom', message:'Skicka rapportinnehåll i exakt ett av report_text eller sections.'});
  if (JSON.stringify(v).length > 150000) ctx.addIssue({code:'custom',message:'Rapporten är för stor. Högst 150 000 tecken totalt.'});
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
function paragraph(template, kind, content) {
  const escaped = escapeXml(content).replace(/\n/g,'</w:t><w:br/><w:t xml:space="preserve">');
  return template.prototypes[kind].replace('__TEXT__', () => escaped);
}
function bodyText(template, textValue) {
  const lines = textValue.replace(/\r\n?/g,'\n').split('\n');
  let buffer=[]; const out=[];
  const flush=()=>{ if(buffer.length) {out.push(paragraph(template,'paragraph',buffer.join('\n'))); buffer=[];} };
  for(const line of lines) {
    const heading=line.match(/^#{1,6}\s+(.+)$/);
    if(heading) { flush(); out.push(paragraph(template,'heading',heading[1])); }
    else if(/^\s*[-*]\s+/.test(line)) {flush(); out.push(paragraph(template,'paragraph','• '+line.replace(/^\s*[-*]\s+/,'')));}
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
  let xml=(data.metadata || []).map(m=>paragraph(template,'metadata',`${m.label}: ${m.value}`)).join('');
  if(data.food_summary && template.id!=='livsmedel') warnings.push('food_summary ignorerades: fältet är tomt och rapporttypen är inte livsmedel.');
  if(data.food_summary && template.id==='livsmedel') {
    xml+=template.prototypes.food_summary.replace(/__PASSED__|__FOLLOWUP__|__DEVIATIONS__/g,slot=>escapeXml(data.food_summary[{__PASSED__:'passed',__FOLLOWUP__:'follow_up',__DEVIATIONS__:'deviations'}[slot]]).replace(/\n/g,'</w:t><w:br/><w:t xml:space="preserve">'));
  }
  if(data.sections) xml+=data.sections.map(s=>(s.heading?paragraph(template,'heading',s.heading):'')+bodyText(template,s.text)).join('');
  else xml+=bodyText(template,data.report_text);
  const source=readFileSync(new URL(`../templates/${template.file}`,import.meta.url));
  const doc=new Docxtemplater(new PizZip(source),{paragraphLoop:true,linebreaks:true,nullGetter:()=>'',errorLogging:false});
  doc.render({title:data.title,report_date:data.report_date||'',case_number:data.case_number||'',inspector:data.inspector||'',recipient:data.recipient||'',report_body:xml});
  const buffer=doc.getZip().generate({type:'nodebuffer',compression:'DEFLATE'});
  const filename=(normalize(data.title).replace(/ /g,'-').slice(0,100)||'inspektionsrapport')+'.docx';
  return {buffer,filename,template_id:template.id,fallback_used:fallback,warnings};
}
