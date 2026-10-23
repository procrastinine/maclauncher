import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawn,spawnSync} from 'node:child_process';import {createRequire} from 'node:module';
import {layout,environment,prepareMountParents,publishPathMap} from '../../src/modules/android/art/layout.mjs';
const require=createRequire(import.meta.url);
export async function probeAshmemInterop({output,runtime,guestInputs,jdk,r8,binder,core,linuxRun,guestBinder,lifecycle=false}){
const root=path.resolve(output),payload=path.resolve(runtime),supplier=require('./android-art-supplier').componentSupplier(payload),c=supplier.components,o=JSON.parse(fs.readFileSync(guestInputs));
const run=(cmd,args,extra={})=>{const r=spawnSync(cmd,args,{cwd:o.sourceRoot,encoding:'utf8',timeout:40000,maxBuffer:4<<20,...extra});if(r.error)throw r.error;if(r.status!==0)throw Error((r.stdout+r.stderr).slice(-12000));return r;};
const fixture=path.resolve(import.meta.dirname,'../fixtures/android-platform-settings'),classes=path.join(root,'classes'),dex=path.join(root,'dex');for(const d of[classes,dex,path.join(root,'native')])fs.mkdirSync(d,{recursive:true});
for(const file of fs.readdirSync(path.join(payload,'native')).filter(name=>name.endsWith('.dylib')))fs.copyFileSync(path.join(payload,'native',file),path.join(root,'native',file),fs.constants.COPYFILE_FICLONE);
const corrected=binder;
fs.copyFileSync(corrected,path.join(root,'native/libandroid-binder-rpc.dylib'),fs.constants.COPYFILE_FICLONE);
if(core)fs.copyFileSync(core,path.join(root,'native/libklepton-jvm.dylib'),fs.constants.COPYFILE_FICLONE);
if(linuxRun){const file=path.join(root,'native/linux-run');fs.copyFileSync(linuxRun,file,fs.constants.COPYFILE_FICLONE);c.linuxRun=file;}
if(guestBinder){const file=path.join(root,'native/libbinder.so');fs.copyFileSync(guestBinder,file,fs.constants.COPYFILE_FICLONE);c.binderLibrary=file;}
run('clang++',['-std=c++20','-O2',path.join(fixture,'ashmem-owner.cpp'),'-o',path.join(root,'owner')]);
run(path.join(jdk,'bin/javac'),['--release','21','-cp',path.join(payload,'android-framework.jar'),'-d',classes,path.join(fixture,'AshmemReceiver.java')]);
run(path.join(jdk,'bin/jar'),['cf',path.join(root,'probe.jar'),'-C',classes,'.']);
run(path.join(jdk,'bin/java'),['-cp',path.resolve(r8),'com.android.tools.r8.D8','--min-api','36','--lib',path.join(payload,'android-framework.jar'),'--output',dex,path.join(root,'probe.jar')]);
run(o.compiler,[...o.includeDirectories.map(d=>'-I'+d),'-I'+path.resolve('src/modules/android/native/binder-rpc'),'-I'+path.resolve('src/modules/android/art/native'),...o.binderFlags,'-c',path.join(fixture,'ashmem-receiver.cpp'),'-o',path.join(root,'receiver.o')]);
run(o.linkCompiler,['-shared','-nostdlib++','-Wl,--no-undefined',path.join(root,'receiver.o'),'-L'+path.join(c.image,'system/lib64'),'-lcutils','-l:libc++.so','-o',path.join(root,'receiver.so')]);
if(lifecycle){
 run(o.compiler,[...o.includeDirectories.map(d=>'-I'+d),'-I'+path.resolve('src/modules/android/native/binder-rpc'),'-I'+path.resolve('src/modules/android/art/native'),...o.binderFlags,'-UNDEBUG','-c',path.join(fixture,'ashmem-lifecycle.cpp'),'-o',path.join(root,'lifecycle.o')]);
 run(o.linkCompiler,['-nostdlib++',path.join(root,'lifecycle.o'),'-L'+path.join(c.image,'system/lib64'),'-l:libc++.so','-o',path.join(root,'lifecycle')]);
}
const state=path.join(root,'state'),properties=path.join(root,'properties-'+crypto.randomUUID()),socketRoot=fs.mkdtempSync('/private/tmp/ashmem-'),producerRoot=fs.mkdtempSync('/private/tmp/ashmem-producer-');fs.mkdirSync(state,{recursive:true});
run(c.bootstrap,[c.image,properties]);run(c.bootstrap,['initialize','10021',socketRoot]);
const binderName='maclauncher.ashmem.'+crypto.randomUUID(),env={...process.env,...environment(supplier),CLASSPATH:environment(supplier).CLASSPATH+':/data/local/tmp/ashmem.dex',LD_PRELOAD:'/system/lib64/libandroid-log-stderr.so',TMPDIR:socketRoot};
const children=[];function child(label,cmd,args,extraEnv={}){const log=fs.openSync(path.join(root,label+'.log'),'w');const p=spawn(cmd,args,{env:{...env,...extraEnv},stdio:['ignore',log,log],detached:true});fs.closeSync(log);children.push(p);return p;}
function alive(p){return p.exitCode==null&&p.signalCode==null;}
async function waitFor(file,needle,p){for(let i=0;i<500;i++){if(fs.existsSync(file)&&fs.readFileSync(file,'utf8').includes(needle))return;if(!alive(p))throw Error(fs.readFileSync(file,'utf8'));await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Fixture startup timeout');}
const sock=path.join(socketRoot,'shared.sock');fs.rmSync(sock,{force:true});
const {profile}=require('../../src/modules/shared/runtime/macos-sandbox'),memory=require('../../src/modules/android/shared-memory-policy'),quote=value=>JSON.stringify(value);
fs.writeFileSync(path.join(producerRoot,'canary'),'private producer neighbor');
try{
 child('binder',c.binder,['--host-module',c.hostLibrary,'--service',binderName]);run(c.bootstrap,['wait-binder',binderName],{env});
 const issuerPolicy=path.join(root,'issuer.sb');fs.writeFileSync(issuerPolicy,profile({readDirectories:[payload,root],readFiles:[],writeDirectories:[producerRoot,socketRoot],executables:[path.join(root,'owner')],blockNetwork:true})+memory.capabilities([producerRoot])+'\n(allow network-bind network-inbound (local unix-socket (subpath '+quote(socketRoot)+')))\n');
 const owner=child('owner','/usr/bin/sandbox-exec',['-f',issuerPolicy,path.join(root,'owner'),path.join(root,'native/libandroid-binder-rpc.dylib'),sock],{LD_PRELOAD:'',TMPDIR:producerRoot});await waitFor(path.join(root,'owner.log'),'READY',owner);
 const rows=[['ro','/dev/__properties__',properties],['rw','/data/local/tmp/ashmem',socketRoot],['ro','/data/local/tmp/ashmem.dex',path.join(dex,'classes.dex')],['ro','/data/local/tmp/neighbor',path.join(producerRoot,'canary')],['ro','/system/lib64/ashmem-receiver.so',path.join(root,'receiver.so')],['ro','/system/lib64/libandroid-log-stderr.so',c.logLibrary],['ro','/system/lib64/libbinder.so',c.binderLibrary]];
 if(lifecycle)rows.push(['ro','/data/local/tmp/ashmem-lifecycle',path.join(root,'lifecycle')]);
 const map=publishPathMap(state,'receiver',prepareMountParents(layout({supplier,state})+rows.map(row=>row.join('\t')+'\n').join(''),path.join(root,'parents')));
 const base=['--inherit-env','--guest-fds','0,1,2','--binder',binderName,'--path-map',map,'--cache',path.join(root,'cache'),'--host-module',c.hostLibrary];
 run(c.linuxRun,[...base,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
 const policy=path.join(root,'receiver.sb');fs.writeFileSync(policy,profile({readDirectories:[payload,root],readFiles:[],writeDirectories:[root,socketRoot],executables:[c.linuxRun,...(lifecycle?[path.join(root,'lifecycle')]:[])],blockNetwork:true,machServices:[binderName]})+memory.capabilities([socketRoot])+'\n(allow process-exec (subpath '+quote(payload)+'))\n'+[root,socketRoot].map(directory=>'(allow network-bind network-inbound (local unix-socket (subpath '+quote(directory)+')))\n(allow network-outbound (remote unix-socket (subpath '+quote(directory)+')))\n').join(''));
 const entry=lifecycle?['/data/local/tmp/ashmem-lifecycle','/data/local/tmp/ashmem/shared.sock']:['/system/bin/app_process64','-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','/system/bin','AshmemReceiver','/data/local/tmp/ashmem/shared.sock'];
 const receiverLog=path.join(root,'receiver.log'),receiverFd=fs.openSync(receiverLog,'w');
 const r=spawnSync('/usr/bin/sandbox-exec',['-f',policy,c.linuxRun,...base,'--identity-text','service\tashmem-fixture\nuid\t10021\ngid\t10021\ncap_effective\t0\ncap_permitted\t0\ncap_bounding\t0\nseclabel\tu:r:untrusted_app:s0\n',...entry],{env,detached:true,stdio:['ignore',receiverFd,receiverFd],timeout:40000});
 fs.closeSync(receiverFd);if(r.pid)try{process.kill(-r.pid,'SIGKILL');}catch{}
 const receiverOutput=fs.readFileSync(receiverLog,'utf8');
 if(r.error)throw r.error;if(r.status!==0)throw Error(receiverOutput.slice(-12000));
 
 await waitFor(path.join(root,'owner.log'),'PASS owner',owner);
 return receiverOutput;
}finally{await Promise.all(children.map(async p=>{if(!alive(p))return;const closed=new Promise(resolve=>p.once('close',resolve));try{process.kill(-p.pid,'SIGKILL');}catch{}await closed;}));for(const directory of[socketRoot,producerRoot])fs.rmSync(directory,{recursive:true,force:true});}

}
