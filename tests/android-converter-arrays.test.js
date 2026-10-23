const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Both DEX array producers discard unused results at control-flow joins',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME||require('../src/modules/android/runtime').runtimeRoot();
 const home=process.env.JAVA_HOME||(process.platform==='darwin'?spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim():'');
 if(!home||!fs.existsSync(path.join(runtime,'dex2jvm.jar')))return t.skip('Requires Java 21 and Android converter');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-converter-arrays-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const fixture=path.join(__dirname,'fixtures/android-converter-arrays');
 const run=(tool,args)=>{const r=spawnSync(path.join(home,'bin',tool),args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 fs.mkdirSync(temporary+'/input');fs.writeFileSync(temporary+'/input/classes.dex',require('./fixtures/android-converter-arrays/make-dex.cjs')());
 run('jar',['--create','--file',temporary+'/source.apk','-C',temporary+'/input','classes.dex']);
 run('java',['-cp',['converter-overlay.jar','dex2jvm.jar'].map(p=>path.resolve(runtime,p)).join(path.delimiter),
  'io.github.kksimp.dex2jvm.ConvertApkSet',path.resolve(runtime,'android-api-metadata.jar'),temporary+'/converted.jar',temporary+'/source.apk']);
 run('javac',['--release','21','-d',temporary,fixture+'/VerifyArrays.java']);
 assert.match(run('java',['-Xverify:all','-cp',temporary,'VerifyArrays',temporary+'/converted.jar']),/PASS filled arrays/);
});
