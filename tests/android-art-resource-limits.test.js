const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('original Bionic resource limits expose the finite kernel FD ceiling and retain lower limits',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:clang}=process.env;
 if(process.platform!=='darwin'||![payload,runner,clang].every(Boolean))return t.skip('Requires original Android Bionic and the selected native runner');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-resource-limits-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(exe,args,options={})=>{const result=spawnSync(exe,args,{encoding:'utf8',timeout:30000,...options});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const ceiling=Number(run('/usr/sbin/sysctl',['-n','kern.maxfilesperproc']).trim());assert.ok(Number.isSafeInteger(ceiling)&&ceiling>0);
 const binary=path.join(root,'probe');run(clang,[path.join(__dirname,'fixtures/android-art-storage/resource-limits.c'),'-o',binary]);
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 for(const principal of ['app','root']){
  const state=path.join(root,principal);fs.mkdirSync(state);
  const map=publishPathMap(state,'limits',prepareMountParents(layout({supplier,state})+`ro\t/system/bin/resource-limits\t${binary}\n`,path.join(state,'parents')));
  const identity=principal==='app'?'service\tlimits\nuid\t10001\ngid\t10001\ncap_effective\t0\ncap_permitted\t0\ncap_bounding\t0\n':'service\tlimits\nuid\t0\ngid\t0\n';
  const output=run(runner,['--inherit-env','--identity-text',identity,'--path-map',map,'--no-cache','/system/bin/resource-limits',String(ceiling),String(process.getuid())],{env:{...environment(supplier),TMPDIR:root}});
  assert.match(output,/PASS original Bionic NOFILE bounds/);t.diagnostic(principal+': '+output.trim());
 }
});
