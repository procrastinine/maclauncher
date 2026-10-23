const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Framework assembly preserves composed original outputs without archive-order class replacement',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout?.trim();
 if(!runtime||!home)return t.skip('Requires an Android runtime and Java21');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-framework-modules-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const source=path.resolve(process.env.KLEPTON_ANDROID_NATIVE_SOURCE||path.join(__dirname,'../src/modules/android/native')),run=(tool,args,encoding='utf8')=>{const r=spawnSync(tool,args,{encoding,timeout:30000,maxBuffer:16<<20});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,String(r.stdout)+String(r.stderr));return r.stdout;};
 const javac=path.join(home,'bin/javac'),jar=path.join(home,'bin/jar'),asm=JSON.parse(fs.readFileSync(path.join(source,'asm-binary.json'))).files.map(f=>path.join(process.env.KLEPTON_ANDROID_TOOLS||path.join(source,'tools'),f.path));
 const cp=[tmp,...asm,...['android-host.jar','android-framework.jar'].map(f=>path.resolve(runtime,f))].join(path.delimiter);
 run(javac,['--release','21','-cp',cp,'-d',tmp,...['framework','portability'].flatMap(directory=>fs.readdirSync(path.join(source,directory)).filter(n=>n.endsWith('.java')).map(n=>path.join(source,directory,n)))]);
 for(const [directory,value]of[['primary',17],['module',17]]){
  const folder=path.join(tmp,directory),classes=path.join(folder,'classes');fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder,'Base.java'),`package publisher; public class Base {public static int answer(){return ${value};}}`);
  const sources=[path.join(folder,'Base.java')];if(directory==='module'){fs.writeFileSync(path.join(folder,'Extra.java'),'package newmodule; public class Extra {public String allMethods(int value){return "value="+value;} public long untouched=123;}');sources.push(path.join(folder,'Extra.java'));}
  const provider=directory==='primary'?'First':'Second';
  if(directory==='primary'){
   fs.writeFileSync(path.join(folder,'Extension.java'),'package publisher; public interface Extension {String name();}');sources.push(path.join(folder,'Extension.java'));
  }
  fs.writeFileSync(path.join(folder,provider+'.java'),`package publisher; public class ${provider} implements Extension {public String name(){return "${provider}";}}`);sources.push(path.join(folder,provider+'.java'));
  run(javac,['--release','21','-cp',path.join(tmp,'primary/classes'),'-d',classes,...sources]);
  fs.mkdirSync(path.join(classes,'META-INF/services'),{recursive:true});
  fs.writeFileSync(path.join(classes,'META-INF/services/publisher.Extension'),`# Original module providers\npublisher.${provider}\npublisher.First # Shared identical provider\n`);
  run(jar,['--create','--file',folder+'.jar','-C',classes,'.']);
 }
 const modules=[{file:path.join(tmp,'module.jar')}];
 // The actual donor entries are compile placeholders, while an application's
 // same-named SDK must remain executable and keep its original class owner.
 const stubs=[...['ZstdInputStream','ZstdOutputStream'].map(n=>'com/github/luben/zstd/'+n+'.class'),'org/tukaani/xz/LZMAOutputStream.class'];
 const placeholders=path.join(tmp,'placeholders');fs.mkdirSync(placeholders,{recursive:true});
 const framework=path.resolve(runtime,'android-framework.jar'),frameworkEntries=run('unzip',['-Z1',framework]).split('\n');
 for(const name of stubs){const file=path.join(placeholders,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,run('unzip',['-p',framework,frameworkEntries.includes(name)?name:'META-INF/maclauncher/compile-only/'+name],null));}
 const donor=path.join(tmp,'donor.jar');run(jar,['--create','--file',donor,'-C',placeholders,'.']);
 modules.push({file:donor});
 const output=path.join(tmp,'joined.jar');run(path.join(home,'bin/java'),['-cp',cp,'FrameworkArchive',path.join(tmp,'primary.jar'),output,...modules.map(row=>row.file)]);
 const entries=run('unzip',['-Z1',output]).trim().split('\n');
 for(const name of stubs){assert.equal(entries.includes(name),false,'Compile placeholder must not shadow application SDK');assert.deepEqual(run('unzip',['-p',output,'META-INF/maclauncher/compile-only/'+name],null),fs.readFileSync(path.join(placeholders,name)),'Original donor declaration bytes remain present');}
 const declarations=path.join(tmp,'declarations.jar');run(path.join(home,'bin/java'),['-cp',cp,'ConversionHeaders',declarations,output]);
 for(const name of stubs)assert.ok(run('unzip',['-Z1',declarations]).split('\n').includes(name),'Conversion metadata retains original donor declaration');
 const sdkSource=path.join(tmp,'sdk-source/ZstdInputStream.java'),sdkClasses=path.join(tmp,'sdk-classes');fs.mkdirSync(path.dirname(sdkSource),{recursive:true});
 fs.writeFileSync(sdkSource,'package com.github.luben.zstd; public class ZstdInputStream extends java.io.FilterInputStream {public ZstdInputStream(java.io.InputStream input){super(input);} public int sdkMember(){return 73;}}');
 run(javac,['--release','21','-d',sdkClasses,sdkSource]);
 const sdk=path.join(tmp,'sdk.jar');run(jar,['--create','--file',sdk,'-C',sdkClasses,'.']);
 const executable=path.join(tmp,'executable.jar');run(path.join(home,'bin/java'),['-cp',cp,'FrameworkArchive',donor,executable,sdk]);
 assert.deepEqual(run('unzip',['-p',executable,stubs[0]],null),fs.readFileSync(path.join(sdkClasses,stubs[0])),'A real same-named implementation is retained, independently of archive order');
 const sdkHeaders=path.join(tmp,'sdk-headers.jar');run(path.join(home,'bin/java'),['-cp',cp,'ConversionHeaders',sdkHeaders,executable]);
 assert.match(run(path.join(home,'bin/javap'),['-classpath',sdkHeaders,'com.github.luben.zstd.ZstdInputStream']),/sdkMember/,'Executable SDK declarations take precedence over compile-only metadata');
 for(const [entry,directory]of[['publisher/Base.class','primary'],['newmodule/Extra.class','module']]){
  const actual=run('unzip',['-p',output,entry],null);assert.deepEqual(actual,fs.readFileSync(path.join(tmp,directory,'classes',entry)),'Publisher body changed: '+entry);
 }
 fs.writeFileSync(path.join(tmp,'Services.java'),'public class Services {public static void main(String[] args){java.util.ServiceLoader.load(publisher.Extension.class).stream().map(p->p.get().name()).sorted().forEach(System.out::println);}}');
 run(javac,['--release','21','-cp',output,'-d',tmp,path.join(tmp,'Services.java')]);
 assert.equal(run(path.join(home,'bin/java'),['-cp',tmp+path.delimiter+output,'Services']).trim(),'First\nSecond','Merged original modules must retain every service implementation');
 // A later upstream module can add behavior to an existing class. It must not
 // disappear behind an earlier archive, even if the old class still links.
 const module=path.join(tmp,'module');
 fs.writeFileSync(path.join(module,'Base.java'),'package publisher; public class Base {public static int answer(){return 99;} public static void addedUpstreamMethod(){}}');
 run(javac,['--release','21','-d',path.join(module,'classes'),path.join(module,'Base.java')]);
 run(jar,['--create','--file',module+'.jar','-C',path.join(module,'classes'),'.']);
 const conflictingOutput=path.join(tmp,'conflicting.jar');
 const conflict=spawnSync(path.join(home,'bin/java'),['-cp',cp,'FrameworkArchive',path.join(tmp,'primary.jar'),conflictingOutput,module+'.jar'],{encoding:'utf8',timeout:30000});
 assert.notEqual(conflict.status,0);
 assert.match(conflict.stderr,/Conflicting framework class owners for publisher\/Base.class/);
 assert.equal(fs.existsSync(conflictingOutput),false,'Conflicting composition must not publish a partial framework');
});
