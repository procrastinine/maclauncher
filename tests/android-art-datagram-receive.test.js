const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('original Bionic datagram lengths survive shared receivers and a zero descriptor limit',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:clang}=process.env;
 if(process.platform!=='darwin'||![payload,runner,clang].every(Boolean))return t.skip('Requires original Android Bionic and the selected native runner');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-datagram-receive-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(exe,args,options={})=>{const result=spawnSync(exe,args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20,...options});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const binary=path.join(root,'probe');run(clang,['-O2','-pthread',path.join(__dirname,'fixtures/android-art-storage/datagram-receive.c'),'-o',binary]);
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);const byPid=path.join(root,'by-pid');fs.mkdirSync(byPid);
 const map=publishPathMap(state,'datagram',prepareMountParents(layout({supplier,state})+`ro\t/system/bin/datagram-probe\t${binary}\n`,path.join(state,'parents')));
 const output=run(runner,['--inherit-env','--guest-fds','0,1,2','--runtime',path.join(root,'kernel'),'--host-module',supplier.components.hostLibrary,'--by-pid',byPid,'--path-map',map,'--no-cache','/system/bin/datagram-probe'],{env:{...environment(supplier),TMPDIR:root}});
 assert.match(output,/PASS original Bionic datagram lengths/);t.diagnostic(output.trim());
});
