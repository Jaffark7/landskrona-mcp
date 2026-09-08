import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { generateReport, listTemplates } from '../src/reports.js';
await mkdir('test-results',{recursive:true});
const fixture=JSON.parse(await readFile(new URL('../examples/report.json',import.meta.url)));
for(const t of listTemplates()) {
  const result=generateReport({...fixture,report_type:t.id,title:`Inspektionsrapport ${t.name}`});
  await writeFile(`test-results/${t.id}.docx`,result.buffer);
}
const long=generateReport({...fixture,sections:Array.from({length:10},(_,i)=>({heading:`Avsnitt ${i+1}`,text:'Detta är en fiktiv notering som används för att kontrollera sidbrytningar och läsbarhet. '.repeat(25)}))});
await writeFile('test-results/long.docx',long.buffer);
const food=generateReport({...fixture,report_type:'livsmedel',title:'Livsmedelskontroll Exempelrestaurangen',food_summary:{passed:'Spårbarhet\nRegistrering',follow_up:'Tidigare notering har följts upp enligt testunderlaget.',deviations:'Fiktiv avvikelse för layouttest. Se rapporttexten.'}});
await writeFile('test-results/food-table.docx',food.buffer);
