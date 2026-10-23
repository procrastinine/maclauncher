const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Native file access shares Java storage and base/split asset namespaces',async t=>{
  const home=process.env.JAVA_HOME,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||!home)return t.skip('Requires macOS and Java 21');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-guest-paths-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const ids=path.join(temporary,'ids');fs.mkdirSync(ids,{mode:0o700});
  const source=path.resolve(__dirname,'../src/modules/android/native'),fixtures=path.join(__dirname,'fixtures/android-framework-services');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:1<<20,env:{...process.env,KL_ANDROID_ID_DIRECTORY:ids}});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const installed=runtime||path.resolve(__dirname,'../src/resources/native-runtimes',require('../src/modules/android/distribution-supplementals.json')[0].directoryRelative);
  const hostArchive=path.join(installed,'android-host.jar');
  const classpath=[hostArchive,path.join(installed,'android-framework.jar')].join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',classpath,'-d',temporary,path.join(source,'java/maclauncher/android/framework/HostFilesystem.java'),path.join(fixtures,'NativeGuestPathsProbe.java'),path.join(fixtures,'FusedModulePathsProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')]);
  fs.copyFileSync(path.join(source,'resources/storage-namespace.json'),path.join(temporary,'maclauncher/android/framework/storage-namespace.json'));
  const dylib=path.join(temporary,'probe.dylib');
  let statfs=[];
  const klepton=process.env.KLEPTON_SOURCE;
  if(!runtime&&klepton){
    const inputs={};for(const [name,original]of Object.entries({shim:'kl_shim.c',slink:'kl_libc_slink.c',libc:'kl_libc.c'})){inputs[name]=path.join(temporary,original);fs.copyFileSync(path.join(klepton,'runtime/libc',original),inputs[name]);}
    const {prepareIoSources}=await import(require('node:url').pathToFileURL(path.join(source,'io-sources.mjs')));prepareIoSources(inputs);
    const libc=fs.readFileSync(inputs.libc,'utf8'),begin=libc.indexOf('typedef struct {',libc.indexOf('// ---------- statfs ----------')),end=libc.indexOf('// ---------- getrandom ----------',begin);
    assert.ok(begin>=0&&end>begin);fs.writeFileSync(path.join(temporary,'statfs.c'),libc.slice(begin,end));
    statfs=['-DKL_TEST_STATFS_SOURCE='+JSON.stringify(path.join(temporary,'statfs.c'))];
  }
  run('clang',['-Wall','-Wextra','-dynamiclib','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),...(!runtime?['-DKL_TEST_DIRECT_MAPPER',...['guest-paths.c'].map(file=>path.join(source,file))]:[]),...statfs,path.join(fixtures,'native-guest-paths.c'),'-o',dylib]);
  assert.match(run(path.join(home,'bin/java'),['-Xcheck:jni','-cp',temporary+path.delimiter+classpath,'NativeGuestPathsProbe',temporary,dylib,...(runtime?[path.resolve(process.env.KLEPTON_NATIVE_LIBRARY||path.join(runtime,'native/libklepton-jvm.dylib'))]:[])]),/PASS shared Java\/native namespace/);
  assert.match(run(path.join(home,'bin/java'),['-Xcheck:jni','-cp',temporary+path.delimiter+classpath,'FusedModulePathsProbe',installed,path.join(temporary,'fused'),dylib]),/PASS fused module APK aliases/);
});
