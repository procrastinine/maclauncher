const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process'),{once}=require('node:events');

test('Binder-only readiness waits for every original service without loading window or media dependencies',{timeout:60000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_GUEST_INPUTS:inputs,ANDROID_ART_SERVICE_WAITER:waiter}=process.env;
 if(process.platform!=='darwin'||![payload,inputs,waiter].every(Boolean))return t.skip('Requires the original ART supplier and Binder-only readiness component');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-service-wait-')),options=JSON.parse(fs.readFileSync(inputs));
 const {components:c,...supplier}=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));supplier.components=c;
 const execute=(command,args,settings={})=>{const result=spawnSync(command,args,{cwd:options.sourceRoot,encoding:'utf8',timeout:20000,maxBuffer:2<<20,...settings});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result;};
 const includes=[path.join(options.output,'source/adapter'),path.join(options.output,'source/binder/include'),path.join(options.output,'source/binder'),...options.includeDirectories];
 const object=path.join(root,'probe.o'),probe=path.join(root,'probe');
 execute(options.compiler,[...includes.map(directory=>'-I'+directory),...options.binderFlags,'-fPIC','-c',path.resolve('tests/fixtures/android-art/ServiceWaitProbe.cpp'),'-o',object]);
 execute(options.linkCompiler||options.cCompiler.replace(/clang$/,'clang++'),['-nostdlib++','-Wl,--no-undefined',object,'-L'+path.dirname(c.binderLibrary),'-L'+path.join(c.image,'system/lib64'),...(options.libraryDirectories||[]).map(directory=>'-L'+directory),'-lbinder','-lutils','-l:libc++.so','-o',probe]);
 const {layout,environment,publishPathMap,prepareMountParents}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state'),composition=path.join(root,'composition'),byPid=path.join(composition,'by-pid');for(const directory of[state,composition,byPid])fs.mkdirSync(directory,{recursive:true});
 const env={...process.env,...environment(supplier),LD_LIBRARY_PATH:'/system/lib64',LD_PRELOAD:'/system/lib64/libandroid-log-stderr.so',KL_ANDROID_ID_DIRECTORY:path.join(root,'ids'),TMPDIR:path.join(root,'ipc')};for(const directory of[env.KL_ANDROID_ID_DIRECTORY,env.TMPDIR])fs.mkdirSync(directory,{mode:0o700});
 const children=[],alive=child=>child.exitCode==null&&child.signalCode==null;
 // Original AIM derivatives are published in read-only directories. Retire
 // only this fixture's generated tree; Dirent never follows input symlinks.
 const remove=directory=>{fs.chmodSync(directory,0o700);for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(entry.isDirectory())remove(path.join(directory,entry.name));fs.rmSync(directory,{recursive:true,force:true});};
 const launch=(name,command,args)=>{const child=spawn(command,args,{env,detached:true,stdio:['pipe','pipe','pipe']});child.output='';for(const stream of[child.stdout,child.stderr])stream.on('data',bytes=>{child.output+=bytes;});children.push(child);return child;};
 const marker=async(child,text)=>{const until=Date.now()+10000;while(!child.output.includes(text)){assert.ok(alive(child),child.output);assert.ok(Date.now()<until,child.output);await new Promise(resolve=>setTimeout(resolve,10));}};
 t.after(async()=>{await Promise.all(children.map(async child=>{if(!alive(child))return;const closed=once(child,'close');try{process.kill(-child.pid,'SIGTERM');}catch{}let timer;await Promise.race([closed,new Promise(resolve=>timer=setTimeout(resolve,1500))]);clearTimeout(timer);if(alive(child))try{process.kill(-child.pid,'SIGKILL');}catch{}await closed;}));assert.ok(children.every(child=>!alive(child)));remove(root);});
 const properties=launch('properties',c.bootstrap,['serve',c.image,composition,byPid]);await marker(properties,'Original native property service ready');
 const binderName='maclauncher.wait.'+crypto.randomUUID();launch('binder',c.binder,['--host-module',c.hostLibrary,'--service',binderName]);execute(c.bootstrap,['wait-binder',binderName],{env});
 let map=layout({supplier,state});for(const directory of['dev/__properties__','dev/socket','dev/pts'])fs.mkdirSync(path.join(state,'run',directory),{recursive:true});
 const rows=[['ro','/dev/__properties__',path.join(composition,'properties')],['rw','/dev/socket/property_service',path.join(composition,'sockets/property_service')],['rw','/dev/socket/property_service_for_system',path.join(composition,'sockets/property_service_for_system')],['ro','/system/lib64/libandroid-log-stderr.so',c.logLibrary],['ro','/system/lib64/libbinder.so',c.binderLibrary],['ro','/system/bin/maclauncher-art-window',c.compositionRoot],['ro','/system/bin/maclauncher-art-service-wait',path.resolve(waiter)],['ro','/system/bin/service-wait-probe',probe]];
 map=publishPathMap(state,'wait-proof',prepareMountParents(rows.map(row=>row.join('\t')+'\n').join('')+map,path.join(root,'parents')));
 const args=['--inherit-env','--guest-fds','0,1,2','--binder',binderName,'--by-pid',byPid,'--path-map',map,'--cache',path.join(root,'cache'),'--host-module',c.hostLibrary,'--identity-text','service\treadiness-probe\nuid\t1000\ngid\t1000\ncap_effective\t0\ncap_permitted\t0\ncap_bounding\t0\nseclabel\tu:r:system_server:s0\n'];
 const linkerArgs=[...args];linkerArgs[linkerArgs.indexOf('--identity-text')+1]='service\tlinkerconfig\nuid\t0\ngid\t0\ncap_effective\t0\ncap_permitted\t0\ncap_bounding\t0\nseclabel\tu:r:init:s0\n';
 execute(c.linuxRun,[...linkerArgs,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
 launch('servicemanager',c.linuxRun,[...args,'/system/bin/servicemanager']);const publisher=launch('publisher',c.linuxRun,[...args,'/system/bin/service-wait-probe']);await marker(publisher,'FIRST');
 const query=launch('query',c.linuxRun,[...args,'/system/bin/maclauncher-art-service-wait','maclauncher.wait.first','maclauncher.wait.second']);
 await new Promise(resolve=>setTimeout(resolve,100));assert.ok(alive(query),'Readiness cannot finish while a required service is absent');
 publisher.stdin.write('2');await marker(publisher,'SECOND');const [queryCode,querySignal]=await once(query,'close');assert.equal(queryCode,0,query.output);assert.equal(querySignal,null);
 const durations={windowQuery:[],binderQuery:[]};
 for(let index=0;index<3;++index)for(const[name,tail]of[['windowQuery',['/system/bin/maclauncher-art-window','--wait-service','maclauncher.wait.first']],['binderQuery',['/system/bin/maclauncher-art-service-wait','maclauncher.wait.first','maclauncher.wait.second']]]){const began=performance.now();execute(c.linuxRun,[...args,...tail],{env});durations[name].push(performance.now()-began);}
 publisher.stdin.end('q');assert.equal((await once(publisher,'close'))[0],0,publisher.output);
 t.diagnostic(JSON.stringify({durations,scope:'Original ready Binder services; no APK or display. Each combined query waits for both names.'}));
 const output=process.env.ANDROID_ART_SERVICE_WAIT_RESULT;if(output)fs.writeFileSync(output,JSON.stringify({durations,scope:'Original ready Binder services; no APK or display'},null,2)+'\n');
});
