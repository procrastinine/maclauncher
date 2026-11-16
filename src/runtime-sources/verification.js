'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Upstream=require('../modules/shared/runtime/upstream');
const {throwIfAborted}=require('../modules/shared/runtime/download-utils');

function readChecksum(text, filename) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim()) || /^([a-f0-9]{64})$/i.exec(line.trim());
    if (match && (!match[2] || match[2] === filename)) return match[1].toLowerCase();
  }
  return null;
}

async function verifySumsFile({ archiveSha256, checksum, filename, signal, label = "Runtime" }, dependencies = {}) {
  throwIfAborted(signal);
  if (!checksum?.url) throw new Error(`The ${label} release lists no checksum file. No runtime was installed.`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-checksum-")), target = path.join(directory, "checksum");
  let text;
  try {
    await (dependencies.download || Upstream.download)(Upstream.listedFile(checksum), target, { signal, headers: { "User-Agent": "maclauncher" } });
    if (fs.statSync(target).size > 64 * 1024) throw new Error("it is larger than a checksum file");
    text = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error(`The ${label} checksum file could not be read (${error.message}). No runtime was installed.`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  const listed = readChecksum(text, filename);
  if (!listed) throw new Error(`The ${label} checksum file names no SHA-256 for the archive. No runtime was installed.`);
  if (listed !== archiveSha256) throw new Error(`The ${label} archive does not match its published SHA-256. No runtime was installed.`);
  return { verified: true, archiveSha256, identity: `publisher-sha256-file:${listed}` };
}
module.exports={readChecksum,verifySumsFile};

function verifyArchiveSums({root,sumsPath}) {
 const crypto=require('node:crypto'),base=fs.realpathSync(root);
 const contained=relative=>{
  if(typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\\')||relative.includes('\0')||relative.split('/').includes('..'))throw new Error('An archive checksum path escapes its payload.');
  const absolute=fs.realpathSync(path.join(base,relative));
  if(!absolute.startsWith(base+path.sep)||!fs.statSync(absolute).isFile())throw new Error('An archive checksum member is outside its payload.');return absolute;
 };
 const list=contained(sumsPath);if(fs.statSync(list).size>16*1024*1024)throw new Error('The archive checksum list is too large.');
 const members=[];
 for(const raw of fs.readFileSync(list,'utf8').split(/\r?\n/)){
  if(!raw.trim())continue;const match=/^([a-f0-9]{64})[ \t]+\*?(.+?)\s*$/i.exec(raw);
  if(!match)throw new Error('The archive checksum list contains an invalid entry.');
  const name=match[2].replace(/^\.\//,''),file=contained(name),sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(sha256!==match[1].toLowerCase())throw new Error(`Archive member ${name} does not match its published SHA-256.`);
  members.push({path:name,sha256});
 }
 if(!members.length)throw new Error('The archive checksum list contains no members.');return{verified:true,members};
}
async function verifySource({source,asset,archiveSha256,root,verificationFiles=[],headers={},signal},dependencies={}){
 require('./schema').validateSource(source);const receipts=[];
 for(const rule of source.verify){
  throwIfAborted(signal);
  if(rule.type==='github-asset-digest'){
   const digest=Upstream.readDigest(asset?.digest||asset?.sha256,'sha256');
   if(digest?.algorithm!=='sha256'||digest.value!==archiveSha256)throw new Error('The archive does not match its published GitHub SHA-256.');
   receipts.push({type:rule.type,verified:true,sha256:digest.value});
  }else if(rule.type==='sums-file'){
   const matches=verificationFiles.filter(file=>new RegExp(rule.match).test(file.name||file.filename||''));
   if(matches.length!==1)throw new Error('A unique publisher checksum file is required.');
   receipts.push({type:rule.type,...await verifySumsFile({archiveSha256,checksum:matches[0],filename:asset.name||asset.filename,signal,label:source.label},dependencies)});
  }else if(rule.type==='archive-sums')receipts.push({type:rule.type,...verifyArchiveSums({root,sumsPath:rule.path})});
  else if(rule.type==='response-header'){
   const value=Object.entries(headers).find(([name])=>name.toLowerCase()===rule.header.toLowerCase())?.[1],digest=Upstream.readDigest(value,'sha256');
   if(digest?.algorithm!=='sha256'||digest.value!==archiveSha256)throw new Error('The archive does not match its published response-header SHA-256.');
   receipts.push({type:rule.type,verified:true,sha256:digest.value});
  }else if(rule.type==='codesign'){
   if(typeof dependencies.verifyCodeSignature!=='function')throw new Error('Strict code-signature verification is not configured.');
   const receipt=await dependencies.verifyCodeSignature({root,source,signal});
   if(receipt?.verified!==true)throw new Error('Strict code-signature verification failed.');
   receipts.push({type:rule.type,...receipt});
  }
 }
 return {verified:true,receipts};
}
module.exports.verifyArchiveSums=verifyArchiveSums;
module.exports.verifySource=verifySource;
