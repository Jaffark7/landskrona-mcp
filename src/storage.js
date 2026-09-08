import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { put, get, list, del } from '@vercel/blob';
import { MIME } from './reports.js';

export function config() {
  const key=process.env.MCP_API_KEY;
  const secret=process.env.DOWNLOAD_SECRET;
  if(!key || key.length<32 || !secret || secret.length<32 || key===secret) throw new Error('Ange två olika nycklar på minst 32 tecken: MCP_API_KEY och DOWNLOAD_SECRET.');
  const base=new URL(process.env.PUBLIC_BASE_URL || '');
  if(base.username || base.password || base.search || base.hash || base.pathname!=='/') throw new Error('PUBLIC_BASE_URL måste vara en origin utan sökväg.');
  if(base.protocol!=='https:' && !(base.protocol==='http:' && ['localhost','127.0.0.1'].includes(base.hostname) && !process.env.VERCEL)) throw new Error('PUBLIC_BASE_URL måste använda HTTPS på Vercel.');
  const driver=process.env.STORAGE_DRIVER || 'blob';
  if(!['blob','local'].includes(driver) || (process.env.VERCEL && driver==='local')) throw new Error('Vercel kräver STORAGE_DRIVER=blob.');
  if(driver==='blob' && !process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN saknas. Koppla ett privat Blob-lager.');
  const ttl=Number(process.env.DOWNLOAD_TTL_SECONDS||3600);
  if(!Number.isInteger(ttl)||ttl<60||ttl>86400) throw new Error('DOWNLOAD_TTL_SECONDS måste vara 60–86400.');
  return {key,secret,base:base.origin,driver,ttl};
}
export function equalSecret(a,b) {
  const aa=Buffer.from(a),bb=Buffer.from(b);
  return aa.length===bb.length && timingSafeEqual(aa,bb);
}
const localRoot=()=>resolve(process.env.LOCAL_STORAGE_DIR||'.local-reports');
const idPattern=/^\d{10}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function signature(payload,secret) {return createHmac('sha256',secret).update(payload).digest('base64url');}
export function signDownload(data, secret) {
  const payload=Buffer.from(JSON.stringify(data)).toString('base64url');
  return payload+'.'+signature(payload,secret);
}
export function verifyDownload(token, secret, now=Math.floor(Date.now()/1000)) {
  if(typeof token!=='string'||token.length>2500) return null;
  const [payload,sig,...extra]=token.split('.');
  if(!payload||!sig||extra.length||!equalSecret(signature(payload,secret),sig)) return null;
  try {
    const data=JSON.parse(Buffer.from(payload,'base64url').toString());
    if(!idPattern.test(data.id)||!Number.isInteger(data.exp)||data.exp<=now||Number(data.id.slice(0,10))!==data.exp||typeof data.filename!=='string'||!/^[a-z0-9-]+\.docx$/.test(data.filename)||data.filename.length>110) return null;
    return data;
  } catch {return null;}
}
export async function saveReport(report) {
  const cfg=config(); const exp=Math.floor(Date.now()/1000)+cfg.ttl;
  const id=`${exp}-${randomUUID()}`;
  if(cfg.driver==='local') {await mkdir(localRoot(),{recursive:true}); await writeFile(resolve(localRoot(),id+'.docx'),report.buffer,{flag:'wx'});}
  else await put(`reports/${id}.docx`,report.buffer,{access:'private',addRandomSuffix:false,contentType:MIME,token:process.env.BLOB_READ_WRITE_TOKEN});
  const token=signDownload({id,exp,filename:report.filename},cfg.secret);
  return {download_url:`${cfg.base}/api/download?token=${token}`,expires_at:new Date(exp*1000).toISOString()};
}
export async function loadReport(id) {
  if(!idPattern.test(id)) return null;
  if(config().driver==='local') {try{return await readFile(resolve(localRoot(),id+'.docx'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  const result=await get(`reports/${id}.docx`,{access:'private',token:process.env.BLOB_READ_WRITE_TOKEN});
  if(result?.statusCode!==200)return null;
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}
// Only delete this application's expired report objects; other store objects are untouched.
export async function cleanupReports() {
  const cfg=config(); const now=Math.floor(Date.now()/1000); let deleted=0;
  const expired=name=>{const id=name.replace(/\.docx$/,''); return idPattern.test(id)&&Number(id.slice(0,10))<=now;};
  if(cfg.driver==='local') {
    const files=await readdir(localRoot()).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    for(const file of files) if(expired(file)){await unlink(resolve(localRoot(),file)); deleted++;}
  } else {
    let cursor;
    do {
      const page=await list({prefix:'reports/',cursor,limit:100,token:process.env.BLOB_READ_WRITE_TOKEN});
      for(const blob of page.blobs) if(expired(blob.pathname.slice(8))){await del(blob.url,{token:process.env.BLOB_READ_WRITE_TOKEN});deleted++;}
      cursor=page.hasMore?page.cursor:undefined;
    } while(cursor);
  }
  return deleted;
}
