const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('./helpers/android-java');

test('Internal DEX identities retain the VM digest when Android providers need class loading',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  const home=process.env.JAVA_HOME||(process.platform==='darwin'?spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim():'');
  if(!runtime||!home)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-host-digest-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=path.resolve('src/modules/android/native/java/maclauncher/android');
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  const env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|DEX2JVM_|KL_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$)/.test(key))delete env[key];
  const run=(tool,args)=>{const result=spawnSync(path.join(home,'bin',tool),args,{encoding:'utf8',env,timeout:20000,maxBuffer:1<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  run('javac',['--release','21','-cp',cp,'-d',directory,source+'/HostDigests.java',path.resolve(__dirname,'../src/modules/android/native/java-jvm/maclauncher/android/DynamicDex.java'),path.resolve('tests/fixtures/android-dynamic-dex/HostDigestProbe.java')]);
  assert.match(run('java',['-Xverify:all','-cp',directory+path.delimiter+cp,'maclauncher.android.HostDigestProbe']),/PASS original VM digest ownership/);
});

test('Original package contexts resolve the complete framework through their default boot parent',async t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  const home=process.env.JAVA_HOME||(process.platform==='darwin'?spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim():'');
  if(!runtime||!home||process.platform!=='darwin')return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-package-loader-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|DEX2JVM_|KL_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$)/.test(key))delete env[key];
  Object.assign(env,(await require('../src/modules/android/process-channel').processNamespace(directory,1)).environment);
  const run=(tool,args)=>{const result=spawnSync(path.join(home,'bin',tool),args,{encoding:'utf8',env,timeout:30000,maxBuffer:1<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const fixtures=path.join(__dirname,'fixtures');
  run('javac',['--release','21','-cp',cp,'-d',directory+'/classes','src/modules/android/native/java/maclauncher/android/HostDigests.java','src/modules/android/native/java-jvm/maclauncher/android/DynamicDex.java','src/modules/android/native/java-jvm/maclauncher/android/framework/HostDexFiles.java',fixtures+'/android-dynamic-dex/PackageContextLoaderProbe.java',fixtures+'/android-framework-services/SyntheticResources.java',fixtures+'/android-framework-services/PackageManifest.java']);
  const converter=['converter-overlay.jar','dex2jvm.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  run('javac',['--release','21','-cp',converter,'-d',directory+'/converter','src/modules/android/native/converter/ConvertApkSet.java']);
  fs.writeFileSync(directory+'/factory.dex',require('./fixtures/android-dynamic-dex/make-factory-dex.cjs')());
  fs.writeFileSync(directory+'/feature.dex',require('./fixtures/android-dynamic-dex/make-dex.cjs')());
  assert.match(run('java',['-Xverify:all','-cp',directory+'/classes'+path.delimiter+cp,'maclauncher.android.PackageContextLoaderProbe',path.resolve(runtime),directory+'/factory.dex',directory+'/data',directory+'/feature.dex',directory+'/converter'+path.delimiter+converter]),/PASS original package context, prepared split membership/);
});

test('Dynamic DEX persists conversions while validating wrapped and side-delegating parent loaders',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  const home=process.env.JAVA_HOME||(process.platform==='darwin'?spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim():'');
  if(!runtime||!home)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-dex-headers-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const fixtures=path.join(__dirname,'fixtures/android-dynamic-dex'),cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  const env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|DEX2JVM_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$)/.test(key))delete env[key];
  const run=(tool,args)=>{const result=spawnSync(path.join(home,'bin',tool),args,{encoding:'utf8',env,timeout:30000,maxBuffer:1<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout+result.stderr;};
  const prepared=directory+'/runtime';fs.mkdirSync(prepared);
  for(const file of ['dex2jvm.jar','android-api-metadata.jar'])fs.copyFileSync(path.resolve(runtime,file),prepared+'/'+file,fs.constants.COPYFILE_FICLONE);
  fs.copyFileSync(path.resolve(runtime,'converter-overlay.jar'),prepared+'/converter-overlay.jar');
  run('javac',['--release','21','-cp',[prepared+'/converter-overlay.jar',prepared+'/dex2jvm.jar'].join(path.delimiter),'-d',directory+'/converter','src/modules/android/native/converter/DynamicDexConvert.java']);
  run('jar',['--update','--file',prepared+'/converter-overlay.jar','-C',directory+'/converter','.']);
  run('javac',['--release','21','-cp',cp,'-d',directory+'/host','src/modules/android/native/java/maclauncher/android/HostDigests.java','src/modules/android/native/java-jvm/maclauncher/android/DynamicDex.java',fixtures+'/DelegatingHeadersProbe.java']);
  for(const [name,superclass]of [['first','HeaderBase'],['second','HeaderMiddle']]){
    const source=directory+'/'+name;fs.mkdirSync(source);
    for(const [type,body]of Object.entries({HeaderBase:'static { System.setProperty("fixture.headers.initialized","yes"); }',HeaderMiddle:'',HeaderLeft:'',HeaderRight:''})){
      const parent=type==='HeaderBase'?'':` extends ${type==='HeaderLeft'?superclass:'HeaderBase'}`;
      fs.writeFileSync(source+'/'+type+'.java',`package fixture.headers; public class ${type}${parent} { ${body} }\n`);
    }
    run('javac',['--release','21','-d',source+'/classes',...['HeaderBase','HeaderMiddle','HeaderLeft','HeaderRight'].map(type=>source+'/'+type+'.java')]);
    run('jar',['--create','--file',directory+'/'+name+'.jar','-C',source+'/classes','.']);
  }
  fs.writeFileSync(directory+'/hierarchy.dex',require('./fixtures/android-dynamic-dex/make-hierarchy-dex.cjs')());
  const cache=directory+'/cache/dynamic-dex/artifacts',expired=path.join(cache,'0'.repeat(64)+'-'+'0'.repeat(64));
  fs.mkdirSync(expired,{recursive:true});fs.writeFileSync(expired+'/classes.jar','');fs.truncateSync(expired+'/classes.jar',257*1024*1024);fs.writeFileSync(expired+'/headers','old');
  const args=['-Xverify:all','-cp',directory+'/host'+path.delimiter+cp,'DelegatingHeadersProbe',prepared,directory+'/cache',directory+'/hierarchy.dex',directory+'/first.jar',directory+'/second.jar'];
  const cold=run('java',args);assert.match(cold,/PASS delegated parent headers/);assert.match(cold,/cache=converted/);
  assert.equal(fs.existsSync(expired),false,'publication reclaims old entries to keep the shared cache bounded');
  const warm=run('java',args);assert.match(warm,/PASS delegated parent headers/);assert.match(warm,/cache=persistent/);assert.doesNotMatch(warm,/cache=converted/);
  // A changed converter identity cannot reuse output from the previous supplier.
  fs.writeFileSync(directory+'/converter/version-marker','changed');run('jar',['--update','--file',prepared+'/converter-overlay.jar','-C',directory+'/converter','version-marker']);
  const changed=run('java',args);assert.match(changed,/PASS delegated parent headers/);assert.match(changed,/cache=converted/);assert.doesNotMatch(changed,/cache=persistent/);
  for(const [index,entry]of fs.readdirSync(cache).entries()){
    if(index%2)fs.unlinkSync(path.join(cache,entry,'headers'));
    else fs.writeFileSync(path.join(cache,entry,'classes.jar'),'interrupted cache data');
  }
  const repaired=run('java',args);assert.match(repaired,/PASS delegated parent headers/);assert.match(repaired,/cache=converted/);
  const repairedWarm=run('java',args);assert.match(repairedWarm,/cache=persistent/);assert.doesNotMatch(repairedWarm,/cache=converted/);
});

test('Android package processes share DEX cache cleanup without deleting live sessions',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  const home=process.env.JAVA_HOME||(process.platform==='darwin'?spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim():'');
  if(!runtime||!home)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-dex-processes-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  const run=(tool,args)=>{const result=spawnSync(path.join(home,'bin',tool),args,{encoding:'utf8',timeout:20000,maxBuffer:1<<20});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  run('javac',['--release','21','-cp',cp,'-d',directory,'src/modules/android/native/java/maclauncher/android/HostDigests.java','src/modules/android/native/java-jvm/maclauncher/android/DynamicDex.java','tests/fixtures/android-dynamic-dex/SharedCacheProbe.java']);
  assert.match(run('java',['-cp',directory+path.delimiter+cp,'SharedCacheProbe',path.resolve(runtime),path.join(directory,'cache')]),/PASS shared DEX cache publication/);
});

test('Original DEX loaders preserve identity across repeated and concurrent native class requests',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 const home=process.env.JAVA_HOME||(process.platform==='darwin'?spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim():'');
 if(!home||!runtime||process.platform!=='darwin')return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
 const fixtures=path.join(__dirname,'fixtures/android-dynamic-dex'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-dex-identity-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$)/.test(key))delete env[key];
 const run=(tool,args)=>{const result=spawnSync(path.join(home,'bin',tool),args,{encoding:'utf8',env,timeout:15000,maxBuffer:1<<20});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run('javac',['--release','21','-cp',cp,'-d',directory+'/classes',fixtures+'/DexDefinitionProbe.java']);
 run('javac',['--release','21','-d',directory+'/value',fixtures+'/Value.java']);
 run('jar',['--create','--file',directory+'/value.jar','-C',directory+'/value','.']);
 assert.match(run('java',['-Xverify:all','-cp',directory+'/classes'+path.delimiter+cp,'DexDefinitionProbe',path.resolve(runtime),directory+'/value.jar',directory+'/data']),/PASS original DEX loader repeated, slash-form and concurrent class identity/);
});

test('Android dynamic loaders preserve usable code and owned class lifetimes', t => {
  const source=path.resolve(__dirname,'../src/modules/android/native');
  const fixtures=path.join(__dirname,'fixtures/android-dynamic-dex');
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  const home=process.env.JAVA_HOME || (process.platform==='darwin' ? spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim() : '');
  if(!home||!runtime||!fs.existsSync(path.join(home,'bin/javac'))||!fs.existsSync(path.join(runtime,'dex2jvm.jar')))return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-dex-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|DEX2JVM_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$)/.test(key))delete env[key];
  const run=(name,args)=>{const r=spawnSync(path.join(home,'bin',name),args,{env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  run('javac',['--release','21','-cp',cp,'-d',temporary+'/classes',fixtures+'/DynamicDexProbe.java']);
  run('javac',['--release','21','-d',temporary+'/parent',fixtures+'/Value.java']);
  run('jar',['--create','--file',temporary+'/parent.jar','-C',temporary+'/parent','.']);
  fs.writeFileSync(temporary+'/owned.dex',require('./fixtures/android-dynamic-dex/make-dex.cjs')());
  fs.writeFileSync(temporary+'/oversized.dex',require('./fixtures/android-dynamic-dex/make-dex.cjs')(24000));
  const output=run('java',['-Xverify:all','-cp',temporary+'/classes'+path.delimiter+cp,'DynamicDexProbe',path.resolve(runtime),temporary+'/owned.dex',temporary+'/parent.jar',temporary+'/cache',temporary+'/oversized.dex']);
  assert.match(output,/PASS real DEX conversion/);
});
