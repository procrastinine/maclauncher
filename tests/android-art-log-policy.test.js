const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('ART persistent logging uses INFO by default and retains original application priority',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_CLANG:clang,ANDROID_ART_LOG_LIBRARY:library,ANDROID_ART_LOG_BASELINE:baseline}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,clang,library].every(Boolean))
  return t.skip('Requires the matched ART image, Android compiler and log transport');
 const retained=process.env.ANDROID_ART_TEST_OUTPUT;
 const root=fs.mkdtempSync(path.join(retained?path.resolve(retained):os.tmpdir(),'android-log-policy-'));
 if(!retained)t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(program,args,options={})=>{
  const result=spawnSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20,...options});
  assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);return result;
 };
 const probe=path.join(root,'log-policy');
 const compiled=run(clang,['-O2',path.resolve('tests/fixtures/android-art/log-policy.c'),'-llog','-ldl','-o',probe]);
 assert.equal(compiled.status,0,compiled.stderr);
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload)),c=supplier.components;
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const properties=path.join(root,'properties');
 const initialized=run(c.bootstrap,[c.image,properties]);assert.equal(initialized.status,0,initialized.stderr);
 const common=layout({supplier,state})+'ro\t/data/local/tmp/log-policy\t'+probe+'\nro\t/dev/__properties__\t'+properties+'\n';
 const mapFor=(name,transport)=>publishPathMap(state,name,prepareMountParents(common+
  (transport?'ro\t/system/lib64/libandroid-log-stderr.so\t'+path.resolve(transport)+'\n':''),path.join(root,'parents')));
 const env={...environment(supplier),...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment};
 const args=map=>['--inherit-env','--guest-fds','0,1,2','--host-module',c.hostLibrary,'--path-map',map,'--no-cache'];
 const map=mapFor('corrected',library);
 const configured=run(c.linuxRun,[...args(map),'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
 assert.equal(configured.status,0,configured.stderr);
 const execute=(label,transport)=>{
  const result=run(c.linuxRun,[...args(mapFor(label,transport)),'/data/local/tmp/log-policy'],
   {env:{...env,...(transport?{LD_PRELOAD:'/system/lib64/libandroid-log-stderr.so'}:{})}});
  fs.writeFileSync(path.join(root,label+'.log'),result.stdout+result.stderr);return result;
 };
 const original=execute('original',null);assert.equal(original.status,0,original.stdout+original.stderr);
 if(baseline){const old=execute('old-transport',baseline);if(old.status===1)assert.match(old.stdout,/verbose=1 debug=1/);else{assert.equal(old.status,0,old.stdout+old.stderr);assert.match(old.stderr,/default debug payload must not persist/);}}
 const corrected=execute('corrected',library);assert.equal(corrected.status,0,corrected.stdout+corrected.stderr);
 assert.match(original.stdout,/verbose=0 debug=0 info=1 error=1/);
 assert.match(corrected.stdout,/DEFAULT priority=4 verbose=0 debug=0 info=1 error=1/);
 assert.doesNotMatch(corrected.stderr,/default debug payload must not persist|explicit error threshold suppresses warning/);
 assert.match(corrected.stdout,/PASS original Android log policy/);
 for(const message of ['ordinary information survives','ordinary warning survives','explicit application debug survives','ordinary error survives'])
  assert.ok(corrected.stderr.includes(message),message);
 t.diagnostic('Evidence '+root);
});
