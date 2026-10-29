const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');

test('both native loaders preserve stripped inline constants while adapting reachable x18',async t=>{
 const runner=process.env.ANDROID_ART_LINUX_RUN,compiler=process.env.ANDROID_CLANG,klepton=process.env.KLEPTON_SOURCE;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![runner,compiler,klepton].every(Boolean))return t.skip('Requires Apple Silicon, original runner, Android Clang and pinned Klepton source');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-inline-data-'));t.after(()=>{
  const writable=directory=>{fs.chmodSync(directory,0o700);for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(entry.isDirectory())writable(path.join(directory,entry.name));};
  writable(root);fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});
 });
 const invoke=(program,args,extra={})=>spawnSync(program,args,{encoding:'utf8',timeout:30000,...extra});
 const run=(program,args)=>{const r=invoke(program,args);assert.equal(r.status,0,r.stdout+r.stderr+String(r.error||r.signal||''));return r.stdout;};
 const fixture=path.join(__dirname,'fixtures/android-native/art-inline-data.S'),executable=path.join(root,'probe');
 run(compiler,['--target=aarch64-linux-android35','-nostdlib','-static-pie','-Wl,-e,_start','-Wl,-s','-Wl,-z,max-page-size=16384',fixture,'-o',executable]);
 const source=path.resolve('src/modules/android/native');
 const {prepareX18Source}=await import('../src/modules/android/native/x18-source.mjs');
 const x18=prepareX18Source(klepton,root),original=fs.readFileSync(path.join(klepton,'runtime/kl_image.c'),'utf8');
 fs.writeFileSync(path.join(root,'image-elf-types.h'),original.slice(original.indexOf('typedef struct { uint8_t e_ident[16]'),original.indexOf('struct kl_image {')));
 const probe=path.join(root,'metadata');
 run('clang',['-O1','-g','-fsanitize=address,undefined','-Werror','-Wno-unused-function','-I'+root,'-I'+source,'-I'+path.join(klepton,'runtime'),'-DKL_X18_SOURCE='+JSON.stringify(x18),path.join(__dirname,'fixtures/android-native/instruction-evidence.c'),path.join(klepton,'runtime/kl_env.c'),'-o',probe]);
 assert.match(run(probe,[executable]),/PASS shared ELF literal bytes/);
 const execute=(program,cache,name)=>{fs.mkdirSync(path.join(root,name),{recursive:true});return invoke(program,['--root',root,'--runtime',path.join(root,name),...(cache?['--cache',path.join(root,'cache')]:['--no-cache']),'/probe']);};
 if(process.env.ANDROID_ART_ORIGINAL_RUN){const old=execute(process.env.ANDROID_ART_ORIGINAL_RUN,false,'old');assert.equal(old.status,31,old.stdout+old.stderr);}
 const translator=process.env.ANDROID_ART_TRANSLATE||path.join(path.dirname(runner),'linux-translate');
 assert.match(run(translator,['--cache',path.join(root,'cache'),'--jobs','1',root]),/1 translated/);
 for(const cache of[true,false]){const r=execute(runner,cache,cache?'aot':'live');assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/PASS stripped inline data and reachable x18/);}
});

test('ART uses the shared register compiler through original AOT and load-time owners',t=>{
 const runner=process.env.ANDROID_ART_LINUX_RUN,compiler=process.env.ANDROID_CLANG;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!runner||!compiler)return t.skip('Requires Apple Silicon, ANDROID_ART_LINUX_RUN and Android Clang');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-registers-'));
 t.after(()=>{const writable=directory=>{fs.chmodSync(directory,0o700);for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(entry.isDirectory())writable(path.join(directory,entry.name));};writable(root);fs.rmSync(root,{recursive:true,force:true});});
 const executable=path.join(root,'probe'),source=path.join(__dirname,'fixtures/android-native/art-registers.S');
 const cc=spawnSync(compiler,['--target=aarch64-linux-android35','-nostdlib','-static-pie','-Wl,-e,_start','-Wl,-z,max-page-size=16384',source,'-o',executable],{encoding:'utf8'});assert.equal(cc.status,0,cc.stderr);
 const invoke=(program,cache,name)=>{fs.mkdirSync(path.join(root,name),{recursive:true});return spawnSync(program,['--root',root,'--runtime',path.join(root,name),...(cache?['--cache',path.join(root,'cache')]:['--no-cache']),'/probe'],{encoding:'utf8',timeout:20000});};
 if(process.env.ANDROID_ART_ORIGINAL_RUN){const original=invoke(process.env.ANDROID_ART_ORIGINAL_RUN,true,'original');assert.ok(original.status===21||original.signal==='SIGSEGV',original.stdout+original.stderr);}
 const translator=process.env.ANDROID_ART_TRANSLATE||path.join(path.dirname(runner),'linux-translate');
 const translated=spawnSync(translator,['--cache',path.join(root,'cache'),'--jobs','1',root],{encoding:'utf8',timeout:20000});
 assert.equal(translated.status,0,translated.stdout+translated.stderr);assert.match(translated.stdout+translated.stderr,/1 translated/,'AOT proof requires a populated original translation cache');
 for(const cache of[true,false]){const result=invoke(runner,cache,cache?'aot':'live');assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS shared x18:/);}
});

test('original Bionic loads 4KB libraries through its 16KB compatibility mode',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:compiler,ANDROID_BIONIC_SOURCE:bionic}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,compiler,bionic].every(Boolean))return t.skip('Requires the original ART image, runner, Android Clang and Bionic headers');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-page-compat-'));
 t.after(()=>{const writable=d=>{fs.chmodSync(d,0o700);for(const e of fs.readdirSync(d,{withFileTypes:true}))if(e.isDirectory())writable(path.join(d,e.name));};writable(root);fs.rmSync(root,{recursive:true,force:true});});
 const {componentSupplier}=require('./helpers/android-art-supplier'),supplier=componentSupplier(path.resolve(payload));
 const run=(program,args,options={})=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:30000,...options});assert.equal(r.status,0,r.stdout+r.stderr+String(r.error||r.signal||''));return r.stdout;};
 // Pinned checkouts are read from their Git objects; a source worktree is not required.
 const {exportSources}=await import('../src/modules/android/native/upstream/source-export.mjs'),pins=require('../src/modules/android/native/source-pins.json');
 exportSources(bionic,pins.aospBionic,['libdl/include_private'],path.join(root,'bionic'));
 const source=path.join(__dirname,'fixtures/android-native/art-page-compat.c'),headers='-I'+path.join(root,'bionic/libdl/include_private');
 run(compiler,['--target=aarch64-linux-android35',headers,'-O2',source,'-L'+path.join(supplier.components.image,'apex/com.android.runtime/lib64/bionic'),'-ldl_android','-ldl','-o',path.join(root,'probe')]);
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'compat',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/fixture\t'+root+'\n',path.join(root,'mounts')));
 const env=environment(supplier);delete env.CLASSPATH;
 for(const bti of [false,true]){
  run(compiler,['--target=aarch64-linux-android35',headers,'-O2','-fPIC','-shared','-DCOMPAT_LIBRARY','-Wl,-z,max-page-size=4096',...(bti?['-DCOMPAT_BTI','-mbranch-protection=standard']:[]),source,'-o',path.join(root,'libcompat.so')]);
  assert.match(run(runner,['--inherit-env','--runtime',path.join(root,bti?'kernel-bti':'kernel'),'--host-module',supplier.components.hostLibrary,'--path-map',map,'--cache',path.join(root,'cache'),'/data/local/tmp/fixture/probe','/data/local/tmp/fixture/libcompat.so'],{env}),/PASS original Bionic 4KB library rejection, compatibility load, relocation and execution/);
 }
});

test('original Bionic fork preserves architectural x18 without overflowing the owned shadow stack',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:compiler}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,compiler].every(Boolean))return t.skip('Requires the original ART image, runner and Android Clang');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-fork-x18-'));
 t.after(()=>{const writable=d=>{fs.chmodSync(d,0o700);for(const e of fs.readdirSync(d,{withFileTypes:true}))if(e.isDirectory())writable(path.join(d,e.name));};writable(root);fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
 const {componentSupplier}=require('./helpers/android-art-supplier'),supplier=componentSupplier(path.resolve(payload));
 const run=(program,args,options={})=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:20000,...options});assert.equal(r.status,0,r.stdout+r.stderr+String(r.error||r.signal||''));return r.stdout;};
 run(compiler,['-O2','-Wall','-Wextra','-Werror',path.join(__dirname,'fixtures/android-native/art-register-fork.c'),'-o',path.join(root,'probe')]);
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'fork-x18',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/fixture\t'+root+'\n',path.join(root,'mounts')));
 const env=environment(supplier);delete env.CLASSPATH;
 const output=run(runner,['--inherit-env','--runtime',path.join(root,'kernel'),'--host-module',supplier.components.hostLibrary,'--path-map',map,'--no-cache','/data/local/tmp/fixture/probe'],{env});
 assert.match(output,/PASS original SCS fork x18 and used bytes/);
 assert.match(output,/PASS ordinary guest mapping fork x18 and used bytes/);
 assert.match(output,/PASS original Bionic fork keeps architectural x18 ownership/);
});
