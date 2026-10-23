#!/usr/bin/env node
// Offline developer evidence collector. Never imported by a build or runtime.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { nativeArtifactEvidence } = createRequire(import.meta.url)('./helpers/android-composition.js');

const args={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i]?.startsWith('--')||!process.argv[i+1])throw new Error('Expected --inventory FILE --review FILE --runtime DIR --java-home DIR --output DIR');args[process.argv[i].slice(2)]=process.argv[i+1];}
for(const key of ['inventory','review','runtime','java-home','output'])if(!args[key])throw new Error('Missing --'+key);
const root=path.resolve(import.meta.dirname,'..'),runtime=fs.realpathSync(args.runtime),output=path.resolve(args.output);
await fsp.mkdir(output,{recursive:true});
const inventory=JSON.parse(await fsp.readFile(args.inventory)),review=JSON.parse(await fsp.readFile(args.review));
const receipt=JSON.parse(await fsp.readFile(path.join(runtime,'build-receipt.json')));
const hash=async file=>{const digest=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);return digest.digest('hex');};
const run=(command,argv)=>{const r=spawnSync(command,argv,{encoding:'utf8',timeout:120000,maxBuffer:192<<20});if(r.error||r.status!==0)throw new Error(command+': '+(r.error||r.stderr||r.stdout));return r.stdout;};
const problems=[],products=[];
for(const item of receipt.products){
 if(typeof item.path!=='string'||path.isAbsolute(item.path)||item.path.split('/').includes('..')||!/^[a-f0-9]{64}$/.test(item.sha256||'')){problems.push('Invalid receipt product identity: '+item.path);continue;}
 try{const actual=await hash(path.join(runtime,item.path));products.push({path:item.path,expectedSha256:item.sha256,sha256:actual,matching:actual===item.sha256});if(actual!==item.sha256)problems.push('Packaged product hash mismatch: '+item.path);}catch(error){problems.push('Missing packaged product: '+item.path+': '+error.message);}
}
const asmDefinition=JSON.parse(await fsp.readFile(path.join(root,'src/modules/android/native/asm-binary.json')));
const asm=asmDefinition.files.map(f=>path.join(root,'src/modules/android/native/tools',f.path)).join(path.delimiter);
const classes=path.join(output,'inventory-classes');await fsp.mkdir(classes,{recursive:true});
run(path.join(args['java-home'],'bin/javac'),['--release','21','-cp',asm,'-d',classes,path.join(root,'tests/fixtures/android-framework-policy/FrameworkArtifactInventory.java')]);
const scan=file=>run(path.join(args['java-home'],'bin/java'),['-cp',classes+path.delimiter+asm,'FrameworkArtifactInventory',file]).trim().split('\n');
const original=fs.realpathSync(path.resolve(root,inventory.framework.path));const originalHash=await hash(original);
if(originalHash!==inventory.framework.sha256)problems.push('Original framework identity differs from source inventory');
const originals=scan(original),actualJars=['android-framework.jar','android-host.jar'],actuals=[];
const jarWitnesses=[];for(const file of actualJars){const entries=scan(path.join(runtime,file));jarWitnesses.push({path:file,sha256:await hash(path.join(runtime,file)),classes:entries.filter(e=>e.startsWith('C\t')).length,members:entries.filter(e=>/^[MF]\t/.test(e)).length});for(const entry of entries)actuals.push(entry);await fsp.writeFile(path.join(output,file+'.members.txt'),entries.join('\n')+'\n');}
await fsp.writeFile(path.join(output,'original-framework.members.txt'),originals.join('\n')+'\n');
const actualSet=new Set(actuals),missing=originals.filter(e=>!e.startsWith('N\t')&&!actualSet.has(e));
// Native methods may become exact Java platform adapters; member identity still must remain.
await fsp.writeFile(path.join(output,'missing-original-members.txt'),missing.join('\n')+'\n');
const nativeEvidence=nativeArtifactEvidence(runtime,products),exports=nativeEvidence.artifacts;
problems.push(...nativeEvidence.problems);
await fsp.writeFile(path.join(output,'native-exports.json'),JSON.stringify(exports,null,2)+'\n');
const expectedProjects=new Map(inventory.manifest.projects.map(p=>[p.name+'@'+p.revision,p]));const seenProjects=new Set();
for(const entry of review.projects||[]){const id=entry.name+'@'+entry.revision;if(seenProjects.has(id))problems.push('Duplicate project decision: '+id);seenProjects.add(id);if(!expectedProjects.has(id))problems.push('Unknown project decision: '+id);if(entry.include!==true&&entry.include!==false)problems.push('Unresolved project decision: '+id);if(!entry.reason?.trim()||!entry.action?.trim())problems.push('Project decision lacks reason/action: '+id);}
for(const id of expectedProjects.keys())if(!seenProjects.has(id))problems.push('Missing project decision: '+id);
const moduleId=(s,m)=>[s.id,s.revision,m.location.file,m.location.line,m.location.column,m.properties.name||''].join('|');
const expectedModules=new Set(inventory.consumedSources.flatMap(s=>(s.scan?.modules||[]).map(m=>moduleId(s,m))));const seenModules=new Set();
for(const m of review.modules||[]){const id=[m.source,m.revision,m.location.file,m.location.line,m.location.column,m.name||''].join('|');if(seenModules.has(id))problems.push('Duplicate module decision: '+id);seenModules.add(id);if(!expectedModules.has(id))problems.push('Unknown module decision: '+id);if(m.include!==true&&m.include!==false)problems.push('Unresolved module decision: '+id);if(!m.reason?.trim()||!m.action?.trim())problems.push('Module decision lacks reason/action: '+id);}
for(const id of expectedModules)if(!seenModules.has(id))problems.push('Missing module decision: '+id);
// Do not pretend independently scanned binaries prove per-component completeness without mapping.
const unmapped=(review.projects||[]).filter(p=>p.include===true&&(!Array.isArray(p.artifacts)||!p.artifacts.length));
for(const p of unmapped)problems.push('Included component lacks concrete supplier-artifact mapping: '+p.path);
for(const p of review.projects||[])for(const a of p.artifacts||[]){const actual=products.find(x=>x.path===a.path);if(!actual||actual.sha256!==a.sha256)problems.push('Component supplier product absent/changed: '+p.path+':'+a.path);}
if(missing.length)problems.push('Original framework declarations require preserved owner or explicit verified JVM boundary: '+missing.length);
const report={schemaVersion:1,complete:problems.length===0,inputs:{inventory:path.resolve(args.inventory),review:path.resolve(args.review),runtime,receiptSha256:await hash(path.join(runtime,'build-receipt.json')),originalFramework:{path:original,sha256:originalHash}},counts:{projects:expectedProjects.size,modules:expectedModules.size,unresolvedProjects:(review.projects||[]).filter(p=>p.include==null).length,unresolvedModules:(review.modules||[]).filter(m=>m.include==null).length,includedProjectsWithoutSupplierMapping:unmapped.length,originalClasses:originals.filter(e=>e.startsWith('C\t')).length,originalMembers:originals.filter(e=>/^[MF]\t/.test(e)).length,missingOriginalDeclarations:missing.length,receiptProducts:products.length,matchingProducts:products.filter(p=>p.matching).length,nativeLibraries:exports.length,nativeExports:exports.reduce((n,e)=>n+e.symbols.length,0)},jars:jarWitnesses,products,problems};
await fsp.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({complete:report.complete,counts:report.counts,report:path.join(output,'report.json')},null,2));if(!report.complete)process.exitCode=1;
