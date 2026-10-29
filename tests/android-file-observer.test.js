const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('Android file observation uses actual filesystem events with bounded lifecycle',async t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||!runtime)return t.skip('Requires macOS and KLEPTON_NATIVE_RUNTIME');
  const jdk=spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'});
  if(jdk.status!==0)return t.skip('Java 21 development tools are not installed');
  const home=jdk.stdout.trim(),root=fs.mkdtempSync(path.join(os.tmpdir(),'android-file-observer-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const classes=path.join(root,'classes'),data=path.join(root,'data');
  const cp=[classes,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
  const files=path.join(data,'files'),cache=path.join(data,'cache');
  for(const directory of [classes,files,cache])fs.mkdirSync(directory,{recursive:true});
  const env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KLEPTON_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  function run(program,args,environment=env){const r=spawnSync(program,args,{env:environment,cwd:environment===env?undefined:data,encoding:'utf8',timeout:20000,maxBuffer:1<<20});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);assert.deepEqual(require('./helpers/android-java').nativeMethodDiagnostics(r.stdout+r.stderr),[],r.stdout+r.stderr);return r.stdout;}
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',classes,path.join(__dirname,'fixtures/android-framework-services/FileObserverProbe.java')]);
  const configFile=path.join(root,'launch.json');fs.writeFileSync(configFile,'{}');
  const sandbox=await require('../src/modules/android/sandbox').prepareSandbox({javaPath:path.join(home,'bin/java'),configFile,dataRoot:data,
    config:{runtimeRoot:path.resolve(runtime),filesRoot:files,cacheRoot:cache,assetsRoot:classes},blockNetwork:true});
  assert.match(run(sandbox.command,[...sandbox.prefix,...sandbox.javaArguments,...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Xcheck:jni','-Xverify:all','-cp',cp,'FileObserverProbe',path.resolve(runtime),data],sandbox.environment),/PASS real file arrival/);
});
