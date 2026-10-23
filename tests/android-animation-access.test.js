const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Original animation public accessors retain ART access on nonpublic target classes',{timeout:30000},t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(!runtime||!home||process.platform!=='darwin')return t.skip('Requires built Android runtime and Java21');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-animation-access-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const source=path.resolve(__dirname,'../src/modules/android/native'),fixture=path.join(__dirname,'fixtures/android-framework-services');
 const asm=JSON.parse(fs.readFileSync(path.join(source,'asm-binary.json'))).files.map(f=>path.join(source,'tools',f.path));
 const framework=path.resolve(runtime,'android-framework.jar'),host=path.resolve(runtime,'android-host.jar'),cp=[temp,...asm,host,framework].join(path.delimiter);
 const run=(tool,args)=>{const r=spawnSync(tool,args,{encoding:'utf8',timeout:20000,maxBuffer:2<<20});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temp,...['UiPortability','UiHooks','UiHookClassFiles'].map(name=>path.join(source,'framework',name+'.java')),path.join(fixture,'PropertyAccessorTransform.java'),path.join(fixture,'PropertyAccessorProbe.java'),path.join(fixture,'../android-window-session/RuntimeFixture.java')]);
 run(path.join(home,'bin/java'),['-cp',cp,'PropertyAccessorTransform',framework,temp]);
 assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',cp,'PropertyAccessorProbe',path.resolve(runtime),temp]),/PASS original animation accessors/);
});
