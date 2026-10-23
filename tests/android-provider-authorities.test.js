const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Android provider resources and duplicate authorities preserve original manifest order',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 const found=process.env.JAVA_HOME?{status:0,stdout:process.env.JAVA_HOME}:spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'});
 if(found.status!==0||!runtime||process.platform!=='darwin')return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
 const home=found.stdout.trim(),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-providers-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),fixtures=path.join(__dirname,'fixtures/android-framework-services');
 for(const [tool,args] of [['javac',['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'ProviderAuthoritiesProbe.java'),path.join(fixtures,'PackageManifest.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')]],['java',['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.ProviderAuthoritiesProbe',path.resolve(runtime),temporary]]]){
  const result=spawnSync(path.join(home,'bin',tool),args,{encoding:'utf8',timeout:30000});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);if(tool==='java')assert.match(result.stdout,/PASS provider resources/);
 }
});
