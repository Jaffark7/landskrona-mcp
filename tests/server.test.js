import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import PizZip from 'pizzip';
import { DOMParser } from '@xmldom/xmldom';
import { posix } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import app, { createReportResult } from '../src/app.js';
import { generateReport, listTemplates, selectTemplate } from '../src/reports.js';
import { config, signDownload, verifyDownload, cleanupReports } from '../src/storage.js';

let http,base,dir;
const key='test-api-'+ 'a'.repeat(40),secret='test-download-'+'b'.repeat(40);
const fixture={title:'Ny rapport Åäö & <test>',report_date:'2026-09-07',case_number:'TEST-123',inspector:'Testinspektör',recipient:'Testmottagare',report_text:'# Sammanfattning\n\nENDA NYA RAPPORTTEXTEN & <xml>\n\n- Första punkten\n- Andra punkten'};
const headers=()=>({'Authorization':`Bearer ${key}`,'Content-Type':'application/json'});
before(async()=>{
  dir=await mkdtemp(join(tmpdir(),'landskrona-test-'));
  Object.assign(process.env,{MCP_API_KEY:key,DOWNLOAD_SECRET:secret,STORAGE_DRIVER:'local',LOCAL_STORAGE_DIR:dir,DOWNLOAD_TTL_SECONDS:'3600',PUBLIC_BASE_URL:'http://localhost:3000'});
  http=app.listen(0,'127.0.0.1');await once(http,'listening');base=`http://127.0.0.1:${http.address().port}`;process.env.PUBLIC_BASE_URL=base;
});
after(async()=>{http.closeAllConnections();await new Promise(resolve=>http.close(resolve));await rm(dir,{recursive:true,force:true});});
test('eight templates; normalized Swedish names and deterministic fallback',()=>{
  assert.equal(listTemplates().length,8);
  assert.equal(selectTemplate('Förskola').template.id,'forskola');
  assert.equal(selectTemplate('Skola energitillsyn').template.id,'skola_energi');
  for(const value of [undefined,'', '../unknown','helt okänd']){assert.equal(selectTemplate(value).template.id,'skola');assert.equal(selectTemplate(value).fallback,true);}
});
test('all templates preserve styles and logo, replace title and eliminate prior body and metadata',async()=>{
  for(const t of listTemplates()){
    const result=generateReport({...fixture,report_type:t.id});
    assert.equal(result.fallback_used,false);
    const zip=new PizZip(result.buffer), source=new PizZip(await readFile(new URL(`../templates/${t.id}.docx`,import.meta.url)));
    const xml=zip.file('word/document.xml').asText();
    assert.ok(xml.includes('Ny rapport Åäö &amp; &lt;test&gt;'));
    assert.ok(xml.includes('ENDA NYA RAPPORTTEXTEN &amp; &lt;xml&gt;'));
    assert.ok(!/202[2-5]-|XXXX|Frida Paulsson|entrecôte|Rådjuret|XXX|__TEXT__|\{report_/.test(xml));
    assert.ok(xml.includes('Landskrona'));
    for(const p of ['word/styles.xml','word/numbering.xml']) assert.deepEqual(zip.file(p).asUint8Array(),source.file(p).asUint8Array());
    assert.ok(Object.keys(zip.files).some(n=>n.startsWith('word/media/')));
    assert.ok(!Object.keys(zip.files).some(n=>n.startsWith('customXml/')||n.startsWith('word/comments')));
  }
});
test('blank, contradictory, oversized and invalid input rejected without storage',async()=>{
  const invalid=[{title:'T'},{title:'T',report_text:'   '},{...fixture,sections:[{text:'Andra texten'}]},{...fixture,title:''},{...fixture,report_text:'x'.repeat(120001)},{...fixture,report_text:'a\u0001b'},{...fixture,recipient:'rad\n'.repeat(9)},{...fixture,unknown:'value'}];
  for(const body of invalid){const r=await fetch(base+'/api/reports',{method:'POST',headers:headers(),body:JSON.stringify(body)});assert.equal(r.status,400);}
  assert.equal((await readdir(dir)).length,0);
});
test('food summary uses original table and only new content',()=>{
  const data={...fixture,report_type:'livsmedel',food_summary:{passed:'NY GODKÄND PUNKT',follow_up:'NY UPPFÖLJNING',deviations:'NY AVVIKELSE'}};
  const xml=new PizZip(generateReport(data).buffer).file('word/document.xml').asText();
  assert.match(xml,/<w:tbl[ >]/);assert.ok(xml.includes('NY AVVIKELSE'));assert.ok(!xml.includes('A01 -'));assert.ok(!xml.includes('HACCP-baserade'));
  assert.throws(()=>generateReport({...data,report_type:'skola'}));
});
test('Word package XML, line breaks, required note parts and relationship targets remain valid',()=>{
  for(const t of listTemplates()){
    const input={...fixture,report_type:t.id,report_text:'Första raden\nAndra raden & <text>\nTredje raden'};
    if(t.id==='livsmedel')input.food_summary={passed:'Första\nAndra',follow_up:'',deviations:'Ny uppgift'};
    const zip=new PizZip(generateReport(input).buffer);
    for(const [name,file] of Object.entries(zip.files)){
      if(!/\.(xml|rels)$/.test(name))continue;
      const errors=[];
      const dom=new DOMParser({onError:(level,message)=>errors.push(message)}).parseFromString(file.asText(),'application/xml');
      assert.deepEqual(errors,[],`${t.id}: ${name}`);
      if(name.endsWith('.rels')){
        const parent=name==='_rels/.rels'?'':posix.dirname(name.replace('/_rels/','/').replace(/\.rels$/,''));
        for(const rel of Array.from(dom.getElementsByTagName('Relationship'))){
          if(rel.getAttribute('TargetMode')==='External')continue;
          const target=posix.normalize(posix.join(parent,rel.getAttribute('Target')));
          assert.ok(zip.file(target),`${t.id}: dangling relationship ${target}`);
        }
      }
    }
    const settings=zip.file('word/settings.xml').asText();
    if(settings.includes('footnotePr'))assert.ok(zip.file('word/footnotes.xml'));
    if(settings.includes('endnotePr'))assert.ok(zip.file('word/endnotes.xml'));
  }
});
test('auth, origin, invalid JSON, request size, unsupported HTTP method',async()=>{
  assert.equal((await fetch(base+'/api/templates')).status,401);
  assert.equal((await fetch(base+'/api/templates',{headers:{Authorization:'Bearer wrong'}})).status,401);
  assert.equal((await fetch(base+'/api/templates',{headers:{...headers(),Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(base+'/api/reports',{method:'POST',headers:headers(),body:'{'})).status,400);
  assert.equal((await fetch(base+'/api/reports',{method:'POST',headers:headers(),body:'x'.repeat(600000)})).status,413);
  assert.equal((await fetch(base+'/api/mcp',{headers:headers()})).status,405);
});
test('real MCP client initializes, lists tools, calls generation and downloads DOCX',async()=>{
  const client=new Client({name:'integration-test',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/api/mcp'),{requestInit:{headers:{Authorization:`Bearer ${key}`}}}));
  try{
    const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name).sort(),['create_inspection_report','list_templates']);
    const listed=await client.callTool({name:'list_templates',arguments:{}});assert.equal(JSON.parse(listed.content[0].text).length,8);
    const result=await client.callTool({name:'create_inspection_report',arguments:fixture});
    assert.ok(!result.isError,JSON.stringify(result));
    const data=JSON.parse(result.content[0].text);assert.equal(data.fallback_used,true);assert.equal(data.template_id,'skola');
    const file=await fetch(data.download_url);assert.equal(file.status,200);assert.equal(file.headers.get('cache-control'),'no-store');assert.match(file.headers.get('content-disposition'),/^attachment/);
    const zip=new PizZip(Buffer.from(await file.arrayBuffer()));assert.ok(zip.file('word/document.xml').asText().includes('ENDA NYA RAPPORTTEXTEN'));
    const bad=await client.callTool({name:'create_inspection_report',arguments:{title:'Saknar text'}});assert.equal(bad.isError,true);
    const tampered=new URL(data.download_url);tampered.searchParams.set('token',tampered.searchParams.get('token')+'x');assert.equal((await fetch(tampered)).status,403);
  }finally{await client.close();}
});
test('concurrent requests produce distinct downloadable files and cross-instance retrieval',async()=>{
  const results=await Promise.all(Array.from({length:5},(_,i)=>fetch(base+'/api/reports',{method:'POST',headers:headers(),body:JSON.stringify({...fixture,title:`Rapport ${i}`,report_text:`Unik ${i}`})}).then(r=>r.json())));
  assert.equal(new Set(results.map(r=>r.download_url)).size,5);
  const other=app.listen(0,'127.0.0.1');await once(other,'listening');
  try{for(const [i,result] of results.entries()){
    const url=new URL(result.download_url);url.port=String(other.address().port);
    const r=await fetch(url);assert.equal(r.status,200);
    assert.ok(new PizZip(Buffer.from(await r.arrayBuffer())).file('word/document.xml').asText().includes(`Unik ${i}`));
  }}finally{other.closeAllConnections();await new Promise(r=>other.close(r));}
});
test('signed URL expiration, path traversal, mismatched expiry and cleanup isolation',async()=>{
  const exp=Math.floor(Date.now()/1000)-1,id=`${exp}-00000000-0000-4000-8000-000000000000`;
  const token=signDownload({id,exp,filename:'rapport.docx'},secret);
  assert.equal(verifyDownload(token,secret),null);
  assert.equal(verifyDownload(signDownload({id:'../../file',exp:exp+100,filename:'rapport.docx'},secret),secret),null);
  assert.equal(verifyDownload(signDownload({id,exp:exp+100,filename:'rapport.docx'},secret),secret),null);
  await writeFile(join(dir,id+'.docx'),'expired');await writeFile(join(dir,'unrelated.txt'),'keep');
  assert.equal(await cleanupReports(),1);assert.equal(await readFile(join(dir,'unrelated.txt'),'utf8'),'keep');
  assert.equal((await fetch(base+'/api/download?token='+token)).status,403);
});
test('production configuration fails closed for ephemeral local storage and missing secrets',()=>{
  process.env.VERCEL='1';assert.throws(()=>config());delete process.env.VERCEL;
  process.env.MCP_API_KEY='';assert.throws(()=>config());process.env.MCP_API_KEY=key;
});
test('health names the failing variable without exposing its value',async()=>{
  const ok=await fetch(`${base}/api/health`);
  assert.equal(ok.status,200);
  assert.deepEqual(await ok.json(),{status:'ok',templates:8});
  const cases=[
    ['MCP_API_KEY','','MCP_API_KEY'],
    ['DOWNLOAD_SECRET','kort','DOWNLOAD_SECRET'],
    ['PUBLIC_BASE_URL','','PUBLIC_BASE_URL'],
    ['PUBLIC_BASE_URL','https://exempel.se/api','PUBLIC_BASE_URL'],
    ['STORAGE_DRIVER','sqlite','STORAGE_DRIVER'],
    ['DOWNLOAD_TTL_SECONDS','5','DOWNLOAD_TTL_SECONDS']
  ];
  for(const [name,bad,expected] of cases){
    const previous=process.env[name];process.env[name]=bad;
    const res=await fetch(`${base}/api/health`);
    const body=await res.json();
    process.env[name]=previous;
    assert.equal(res.status,503,`${name} ska ge 503`);
    assert.equal(body.status,'configuration_required');
    assert.equal(body.variable,expected,`${name} ska namnges`);
    assert.ok(body.message.length>0);
    if(bad)assert.ok(!JSON.stringify(body).includes(bad),`${name}: värdet får inte läcka`);
  }
  assert.ok(!JSON.stringify(await (await fetch(`${base}/api/health`)).json()).includes(secret));
});
test('configured Intric origin passes CORS while unknown origins stay blocked',async()=>{
  const intric='https://landskrona.intric.ai';
  process.env.ALLOWED_ORIGINS=intric;
  const pre=await fetch(`${base}/api/mcp`,{method:'OPTIONS',headers:{Origin:intric,'Access-Control-Request-Method':'POST'}});
  assert.equal(pre.status,204);
  assert.equal(pre.headers.get('access-control-allow-origin'),intric);
  assert.match(pre.headers.get('access-control-allow-headers')||'',/authorization/i);
  assert.equal(pre.headers.get('vary'),'Origin');
  const ok=await fetch(`${base}/api/templates`,{headers:{...headers(),Origin:intric}});
  assert.equal(ok.status,200);
  assert.equal(ok.headers.get('access-control-allow-origin'),intric);
  const evil=await fetch(`${base}/api/templates`,{headers:{...headers(),Origin:'https://evil.example'}});
  assert.equal(evil.status,403);
  assert.equal(evil.headers.get('access-control-allow-origin'),null);
  assert.equal((await fetch(`${base}/api/mcp`,{method:'OPTIONS',headers:{Origin:'https://evil.example','Access-Control-Request-Method':'POST'}})).status,403);
  delete process.env.ALLOWED_ORIGINS;
  assert.equal((await fetch(`${base}/api/templates`,{headers:{...headers(),Origin:base}})).status,200);
  assert.equal((await fetch(`${base}/api/templates`,{headers:{...headers(),Origin:intric}})).status,403);
});
test('health reports a malformed ALLOWED_ORIGINS',async()=>{
  for(const bad of ['inte-en-adress','https://landskrona.intric.ai/admin']){
    process.env.ALLOWED_ORIGINS=bad;
    const res=await fetch(`${base}/api/health`);const body=await res.json();
    delete process.env.ALLOWED_ORIGINS;
    assert.equal(res.status,503);
    assert.equal(body.variable,'ALLOWED_ORIGINS');
  }
  assert.equal((await fetch(`${base}/api/health`)).status,200);
});
test('empty food_summary is ignored instead of rejected for non-food templates',()=>{
  const tom={passed:'',follow_up:'',deviations:''};
  const result=generateReport({...fixture,report_type:'avfall',food_summary:tom});
  assert.equal(result.template_id,'avfall');
  assert.ok(result.warnings.some(w=>/food_summary/i.test(w)),'ska varna om att faltet ignorerades');
  assert.ok(result.buffer.length>0);
  assert.throws(()=>generateReport({...fixture,report_type:'avfall',food_summary:{passed:'Kylrum kontrollerat',follow_up:'',deviations:''}}),
    /livsmedel/,'ifyllt food_summary mot fel mall ska fortfarande avvisas');
  const mat=generateReport({...fixture,report_type:'livsmedel',food_summary:{passed:'A',follow_up:'B',deviations:'C'}});
  assert.equal(mat.template_id,'livsmedel');
  assert.equal(mat.warnings.filter(w=>/food_summary/i.test(w)).length,0);
  const tomMat=generateReport({...fixture,report_type:'livsmedel',food_summary:tom});
  assert.equal(tomMat.template_id,'livsmedel');
});
test('bullets use the Word list style and links become real hyperlinks',()=>{
  const r=generateReport({...fixture,report_type:'avfall',
    report_text:'# Anmärkningar\n- Första punkten\n- Andra punkten\n\nEnligt [2 kap. 3 § miljöbalken](https://www.riksdagen.se/x) gäller detta. Se även https://www.riksdagen.se/y för mer.'});
  const zip=new PizZip(r.buffer);
  const doc=zip.file('word/document.xml').asText();
  const rels=zip.file('word/_rels/document.xml.rels').asText();
  assert.ok(doc.includes('w:val="Punktlista"'),'punkter ska anvanda Punktlista');
  assert.ok(!/•/.test(doc),'inget litteralt bullet-tecken kvar');
  assert.equal((doc.match(/<w:hyperlink/g)||[]).length,2,'tva lankar');
  assert.ok(doc.includes('2 kap. 3 § miljöbalken'),'lanktexten ska synas');
  assert.ok(!doc.includes('](https'),'markdown-syntaxen ska inte lacka ut');
  assert.ok(!doc.includes('>https://www.riksdagen.se/x<'),'URL:en ska inte visas som text');
  assert.ok(rels.includes('TargetMode="External"'));
  assert.ok(rels.includes('https://www.riksdagen.se/x'));
  assert.ok(rels.includes('https://www.riksdagen.se/y'));
  // livsmedelsmallen saknar Punktlista och behaller tecknet
  const mat=generateReport({...fixture,report_type:'livsmedel',report_text:'- En punkt'});
  assert.ok(new PizZip(mat.buffer).file('word/document.xml').asText().includes('•'));
  // farliga protokoll blir aldrig lankar
  const ond=generateReport({...fixture,report_type:'avfall',report_text:'Se [klick](javascript:alert(1)) here'});
  const ondDoc=new PizZip(ond.buffer).file('word/document.xml').asText();
  assert.ok(!ondDoc.includes('<w:hyperlink'),'javascript: ska inte bli lank');
});
test('generated document matches the original layout and keeps the vector logo',()=>{
  const r=generateReport({...fixture,report_type:'avfall',
    report_text:'# Anmärkningar\n- Punkt ett\n- Punkt två'});
  const zip=new PizZip(r.buffer);
  const doc=zip.file('word/document.xml').asText();
  const paras=doc.slice(doc.indexOf('<w:body>')).split(/(?=<w:p[ >])/).filter(b=>b.startsWith('<w:p'));
  const numId=b=>(b.match(/<w:numId w:val="(\d+)"\/>/)||[])[1];
  // Originalets varden: rubriker automatnumreras med numId 10, punkter anvander numId 13.
  const rubriker=paras.filter(b=>/w:pStyle w:val="Rubrik1"/.test(b));
  const punkter=paras.filter(b=>/w:pStyle w:val="Punktlista"/.test(b));
  assert.ok(rubriker.length>0 && punkter.length===2);
  rubriker.forEach(b=>assert.equal(numId(b),'10','rubriker ska numreras som i originalet'));
  punkter.forEach(b=>assert.equal(numId(b),'13','punkter ska ha originalets indrag'));
  // Logotypen ska vara vektor, inte bara bitmappen.
  assert.ok(zip.file('word/media/image2.svg'),'SVG-logotypen ska folja med');
  assert.ok(doc.includes('svgBlip'),'blip ska peka pa vektorversionen');
  assert.ok(zip.file('[Content_Types].xml').asText().includes('Extension="svg"'));
  assert.equal(zip.file('word/media/image1.png').asNodeBuffer().length,12456,'PNG-reserven ska vara orord');
});
test('photos become a separate appendix document with embedded images',()=>{
  // 2x3 PNG, tillrackligt for att matten ska kunna lasas ur filhuvudet.
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAAG7fl8AAAAEklEQVR4nGP8//8/AzbAhFVkyAIAcvcD+3PNOhoAAAAASUVORK5CYII=','base64');
  const r=generateReport({...fixture,report_type:'avfall',report_text:'# Anmärkningar\n- En punkt',
    images:[{data:png.toString('base64'),caption:'IBC-behållare utan invallning.'},
            {data:'data:image/png;base64,'+png.toString('base64')},
            {data:'inte-en-bild'}]});
  assert.equal(r.image_count,2,'tva giltiga foton');
  assert.ok(r.warnings.some(w=>/Bild 3/.test(w)),'det trasiga fotot ska redovisas');
  // Rapporten sjalv ska aldrig innehalla foton.
  const rapport=new PizZip(r.buffer);
  assert.equal(Object.keys(rapport.files).filter(f=>/^word\/media\/mcpbild/.test(f)).length,0);
  assert.ok(r.appendix,'fotobilaga ska skapas');
  assert.match(r.appendix.filename,/^fotobilaga-/);
  const bilaga=new PizZip(r.appendix.buffer);
  const doc=bilaga.file('word/document.xml').asText();
  assert.equal((doc.match(/rIdMcpBild/g)||[]).length,2,'tva av vara bilder, mallens logotyp raknas inte');
  assert.ok(doc.includes('Bild 1. IBC-behållare utan invallning.'));
  assert.ok(bilaga.file('word/media/mcpbild1.png'),'bildfilen ska ligga i paketet');
  assert.ok(bilaga.file('word/_rels/document.xml.rels').asText().includes('rIdMcpBild1'));
  assert.ok(bilaga.file('[Content_Types].xml').asText().includes('Extension="png"'));
  // Matten ska bevara sidforhallandet 2:3.
  const block=doc.split('<w:drawing>').find(b=>b.includes('rIdMcpBild1'));
  const ext=block.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/);
  assert.ok(Math.abs((Number(ext[2])/Number(ext[1]))-1.5)<0.01,'sidforhallandet ska bevaras');
});
test('MCP result carries a separate link for the photo appendix',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAAG7fl8AAAAEklEQVR4nGP8//8/AzbAhFVkyAIAcvcD+3PNOhoAAAAASUVORK5CYII=','base64');
  const result=await createReportResult({...fixture,report_type:'avfall',report_text:'# Anmärkningar\n- En punkt',
    images:[{data:png.toString('base64'),caption:'Behållare utan invallning.'}]});
  assert.ok(!result.isError,'anropet ska lyckas');
  const d=result.structuredContent;
  assert.equal(d.image_count,1);
  assert.ok(d.download_url && d.appendix_download_url,'bada lankarna ska finnas');
  assert.notEqual(d.download_url,d.appendix_download_url,'lankarna ska peka pa olika filer');
  assert.match(d.appendix_filename,/^fotobilaga-/);
  assert.equal(result.content.filter(c=>c.type==='resource_link').length,2);
  // Bilagan ska ga att ladda ner och innehalla bilden.
  const res=await fetch(d.appendix_download_url);
  assert.equal(res.status,200);
  const zip=new PizZip(Buffer.from(await res.arrayBuffer()));
  assert.ok(zip.file('word/media/mcpbild1.png'));
  // Rapporten sjalv ska inte ha nagot foto.
  const rapport=new PizZip(Buffer.from(await (await fetch(d.download_url)).arrayBuffer()));
  assert.equal(Object.keys(rapport.files).filter(f=>/mcpbild/.test(f)).length,0);
});
test('markdown bold becomes real bold and never leaks asterisks',()=>{
  const r=generateReport({...fixture,report_type:'avfall',
    report_text:'# Anmärkningar\n- **Utomhus, baksidan:** Tre behållare utan invallning.\n\nText med **fet del** mitt i och en [länk](https://www.riksdagen.se/x).'});
  const doc=new PizZip(r.buffer).file('word/document.xml').asText();
  const txt=(doc.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)||[]).map(t=>t.replace(/<[^>]+>/g,'')).join('');
  assert.equal((txt.match(/\*\*/g)||[]).length,0,'inga asterisker far synas');
  assert.ok(txt.includes('Utomhus, baksidan:'),'texten ska finnas kvar');
  assert.ok(txt.includes('fet del'));
  assert.equal((doc.match(/<w:rPr><w:b\/><w:bCs\/><\/w:rPr>/g)||[]).length,2,'tva fetstilta partier, brevhuvudets egen fetstil raknas inte');
  assert.equal((doc.match(/<w:hyperlink/g)||[]).length,1,'lanken ska fortfarande fungera');
  assert.ok(!txt.includes('https://www.riksdagen.se/x'),'markdownlankens adress ska vara dold');
  // Ensamma asterisker ska lamnas i fred, inte tolkas som formatering.
  const kvar=generateReport({...fixture,report_type:'avfall',report_text:'Mata 5 * 3 meter och ** kvar.'});
  const kvarTxt=new PizZip(kvar.buffer).file('word/document.xml').asText();
  assert.ok(kvarTxt.includes('5 * 3 meter'));
});
test('the letterhead logo sits behind the text in every template',()=>{
  for(const t of listTemplates()){
    const doc=new PizZip(generateReport({...fixture,report_type:t.id}).buffer).file('word/document.xml').asText();
    const anchor=doc.slice(doc.indexOf('<wp:anchor'),doc.indexOf('<wp:extent'));
    assert.match(anchor,/behindDoc="1"/,`${t.id}: logotypen ska ligga bakom texten som i originalet`);
    assert.ok(doc.includes('svgBlip'),`${t.id}: vektorversionen ska vara kvar`);
  }
});
