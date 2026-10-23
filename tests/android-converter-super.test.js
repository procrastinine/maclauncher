const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('APK conversion resolves external interface defaults across the complete hierarchy',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME||require('../src/modules/android/runtime').runtimeRoot();
 const home=process.env.JAVA_HOME||(process.platform==='darwin'?spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim():'');
 if(!home||!fs.existsSync(path.join(runtime,'dex2jvm.jar')))return t.skip('Requires Java 21 and Android converter');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-converter-super-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const fixture=path.join(__dirname,'fixtures/android-converter-super');
 const run=(tool,args)=>{const r=spawnSync(path.join(home,'bin',tool),args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 fs.mkdirSync(path.join(temporary,'empty'));
 run('jar',['--create','--file',temporary+'/empty.jar','-C',temporary+'/empty','.']);
 run('javac',['--release','8','-d',temporary+'/api',fixture+'/api/Callback.java']);
 run('jar',['--create','--file',temporary+'/api.jar','-C',temporary+'/api','.']);
 run('jar',['--create','--file',temporary+'/source.apk','-C',fixture,'classes.dex']);
 run('java',['-cp',['converter-overlay.jar','dex2jvm.jar'].map(p=>path.resolve(runtime,p)).join(path.delimiter),
  'io.github.kksimp.dex2jvm.ConvertApkSet',[temporary+'/empty.jar',temporary+'/api.jar'].join(path.delimiter),temporary+'/converted.jar',temporary+'/source.apk']);
 run('javac',['--release','21','-d',temporary,fixture+'/VerifySuper.java']);
 assert.match(run('java',['-Xverify:all','-cp',temporary,'VerifySuper',temporary+'/converted.jar',temporary+'/api.jar']),/PASS converted external interface super receiver/);
});
