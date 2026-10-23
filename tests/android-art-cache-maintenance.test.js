const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('original ART mutable execution permits userspace cache maintenance',{timeout:25000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:compiler}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,compiler].every(Boolean))return t.skip('Requires Apple Silicon, ART supplier, precise runner and Android Clang');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-cache-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const built=spawnSync(compiler,['-O2','-Wall','-Wextra','-Werror',path.join(__dirname,'fixtures/android-native/art-cache-maintenance.c'),'-o',path.join(root,'probe')],{encoding:'utf8',timeout:10000});
 assert.ifError(built.error);assert.equal(built.status,0,built.stdout+built.stderr);
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);const map=publishPathMap(state,'cache-maintenance',prepareMountParents(layout({supplier,state})+'rw\t/data/local/tmp/cache-maintenance\t'+root+'\n',path.join(root,'mounts')));
 const env=environment(supplier);delete env.CLASSPATH;if(process.env.ANDROID_ART_FRAMEWORK_PATH)env.DYLD_FRAMEWORK_PATH=process.env.ANDROID_ART_FRAMEWORK_PATH;
 const baseline=process.env.ANDROID_EXPECT_CACHE_EXCEPTION==='1';
 const result=spawnSync(runner,['--inherit-env','--runtime',path.join(root,'kernel'),'--host-module',supplier.components.hostLibrary,'--path-map',map,'--no-cache','/data/local/tmp/cache-maintenance/probe',baseline?'--baseline':'--fixed'],{env,encoding:'utf8',timeout:15000,maxBuffer:1<<20});
 if(process.env.ANDROID_CACHE_CONTROL_OUTPUT){const output=process.env.ANDROID_CACHE_CONTROL_OUTPUT;fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'stdout.log'),result.stdout||'');fs.writeFileSync(path.join(output,'stderr.log'),result.stderr||'');}
 assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);assert.ok(result.stdout.includes('PASS original mutable cache sequence result=11 EL0_exceptions='+(baseline?4:0)),result.stdout+result.stderr);t.diagnostic(result.stdout.trim());
});
