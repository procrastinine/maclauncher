const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');

const cached=process.env.ANDROID_MUTABLE_AOT==='1';
test(cached?'original Bionic cached library preserves source views, mutable execution and discard':'original Bionic mutable code preserves source views, faults, native writers and mapping lifetimes',{timeout:90000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:compiler}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,compiler].every(Boolean))return t.skip('Requires Apple Silicon, ART supplier, precise runner and Android Clang');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-mutable-code-'));t.after(()=>{
  // The translator deliberately publishes immutable cache directories. Only
  // this fixture's private directories are made removable; links stay links.
  const pending=[root];while(pending.length){const at=pending.pop();const info=fs.lstatSync(at);if(!info.isDirectory()||info.isSymbolicLink())continue;fs.chmodSync(at,info.mode|0o700);for(const item of fs.readdirSync(at))pending.push(path.join(at,item));}
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 });
 const retained=process.env.ANDROID_MUTABLE_CODE_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 const invoke=(program,args,extra={})=>spawnSync(program,args,{encoding:'utf8',timeout:60000,maxBuffer:4<<20,...extra});
 const fixture=process.env.ANDROID_MUTABLE_FIXTURE||path.join(__dirname,'fixtures/android-native/art-mutable-code.c');
 const built=invoke(compiler,['-O2','-Wall','-Wextra','-Werror','-march=armv8.1-a',fixture,'-o',path.join(root,'probe')]);
 assert.ifError(built.error);assert.equal(built.status,0,built.stdout+built.stderr);
 if(cached){
  const library=invoke(compiler,['-shared','-fPIC','-nostdlib','-Wl,-z,max-page-size=16384',path.join(path.dirname(fixture),'art-mutable-library.S'),'-o',path.join(root,'libmutable.so')]);
  assert.ifError(library.error);assert.equal(library.status,0,library.stdout+library.stderr);
  const translator=process.env.ANDROID_ART_TRANSLATE||path.join(path.dirname(runner),'linux-translate');
  const translated=invoke(translator,['--cache',path.join(root,'cache'),'--jobs','1',root]);
  assert.ifError(translated.error);assert.equal(translated.status,0,translated.stdout+translated.stderr);
  if(retained){fs.writeFileSync(path.join(retained,'translate.log'),translated.stdout+translated.stderr);fs.copyFileSync(path.join(root,'libmutable.so'),path.join(retained,'libmutable.so'));}
 }
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'mutable',prepareMountParents(layout({supplier,state})+'rw\t/data/local/tmp/probe\t'+root+'\n',path.join(root,'mounts'))),env=environment(supplier);delete env.CLASSPATH;
 if(process.env.ANDROID_ART_FRAMEWORK_PATH)env.DYLD_FRAMEWORK_PATH=process.env.ANDROID_ART_FRAMEWORK_PATH;
 const logs=retained||root,out=path.join(logs,'stdout.log'),err=path.join(logs,'stderr.log'),descriptors=[fs.openSync(out,'w'),fs.openSync(err,'w')];
 const hostLibrary=process.env.ANDROID_ART_HOST_LIBRARY||supplier.components.hostLibrary;
 const child=spawn(runner,['--inherit-env','--runtime',path.join(root,'kernel'),'--host-module',hostLibrary,'--path-map',map,...(cached?['--cache',path.join(root,'cache')]:['--no-cache']),'/data/local/tmp/probe/probe','/data/local/tmp/probe',...(cached?['/data/local/tmp/probe/libmutable.so']:process.env.ANDROID_ART_HOST_LIBRARY?['--host-packet']:[])],{env,detached:true,stdio:['ignore',...descriptors]});
 for(const descriptor of descriptors)fs.closeSync(descriptor);
 if(retained)fs.writeFileSync(path.join(retained,'process.json'),JSON.stringify({pid:child.pid,runner,fixture,startedAt:new Date().toISOString()})+'\n');
 const result=await new Promise(resolve=>{
  let error=null,timedOut=false,kill=null;
  const signal=kind=>{try{process.kill(-child.pid,kind);}catch(e){if(e.code!=='ESRCH')throw e;}};
  const timer=setTimeout(()=>{timedOut=true;signal('SIGTERM');kill=setTimeout(()=>signal('SIGKILL'),2500);},60000);
  child.once('error',value=>{error=value;});
  child.once('close',(status,termination)=>{clearTimeout(timer);if(kill)clearTimeout(kill);if(status!==0||termination)signal('SIGKILL');resolve({status,signal:termination,error:error||(timedOut?new Error('Mutable lifecycle fixture timed out'):null),stdout:fs.readFileSync(out,'utf8'),stderr:fs.readFileSync(err,'utf8')});});
 });
 if(retained)fs.writeFileSync(path.join(retained,'process-result.json'),JSON.stringify({pid:child.pid,status:result.status,signal:result.signal,finishedAt:new Date().toISOString()})+'\n');
 assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 const messages=cached?['cached original library was translated and executes','cached original library restores source words and mutable execution','cached original library discard reloads authenticated original bytes','cached original library retires mappings normally']:['original far source before mutable enrollment','original bytes, virtual RWX and NX fault entry','original native writer continuation and read visibility','original SVC dispatch and thread-pointer state in enrolled code','original self-store publishes before the next instruction fetch','original exclusive retry loop in enrolled code','concurrent original fetches and native atomic writers','original signal and RX write denial without changing source bytes','original move, growth and independently owned source tail','original DONTUNMAP, private reload and source isolation','original fork preserves original views and private write isolation','genuine original BRK is distinct from historical fetched veneer','original anonymous discard and complete mutable mapping retirement'];
 for(const message of messages)assert.ok(result.stdout.includes('PASS '+message),result.stdout+result.stderr);
 if(cached)assert.ok(result.stdout.includes('PASS cached original shared readonly mapping preserves source permissions'),result.stdout+result.stderr);
 if(!cached)assert.ok(result.stdout.includes('PASS original native exclusive writer resumes across owned write fault'),result.stdout+result.stderr);
 if(!cached)assert.ok(result.stdout.includes('PASS original concurrent executor survives mutable enrollment'),result.stdout+result.stderr);
 if(!cached)for(const message of ['original asynchronous signal interrupts CPU-bound private-data stores','original SIGTERM interrupts CPU-bound stores'])assert.ok(result.stdout.includes('PASS '+message),result.stdout+result.stderr);
 if(!cached)assert.ok(result.stdout.includes('PASS original typed Darwin host module writes an enrolled argument block'),result.stdout+result.stderr);
 if(!cached&&process.env.ANDROID_ART_HOST_LIBRARY)assert.ok(result.stdout.includes('PASS original C extension writes an enrolled typed clock packet'),result.stdout+result.stderr);
 if(!cached&&process.env.ANDROID_ART_HOST_LIBRARY)assert.ok(result.stdout.includes('PASS original C packet access preserves readonly inputs and rejects writes'),result.stdout+result.stderr);
 t.diagnostic(result.stdout.trim());
});
