const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync,spawn}=require('node:child_process');

test('original content providers retain package contexts, lifecycle, publication, permissions, cursor and reference ownership across processes',async t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-remote-content-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const cp=[output,...['android-host.jar','android-framework.jar','apksig.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  const native=path.resolve('src/modules/android/native/java/maclauncher/android');
  const changed=['LocalProviders.java','HostDigests.java','framework/HostContext.java','framework/HostGoogleProviders.java','framework/HostProviderConnections.java','framework/HostPlatformPackages.java','framework/HostActivityService.java','framework/HostRemoteServices.java','framework/HostProcessServices.java','framework/HostServiceDirectory.java','framework/HostPackages.java','framework/HostPermissions.java','framework/HostContextServices.java','framework/HostWindowManager.java','framework/HostAppOps.java'];
  execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,...changed.map(name=>path.join(native,name)),path.resolve('tests/fixtures/android-framework-services/RemoteContentProviderProbe.java'),path.resolve('tests/fixtures/android-framework-services/SignApkSet.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],{stdio:'pipe'});
  // The framework verifies real publisher signatures. Both fixture packages
  // use one ephemeral signer, exactly like a publisher's separate components.
  const key=path.join(output,'signer.p12');
  execFileSync(path.join(home,'bin/keytool'),['-genkeypair','-alias','owned','-keyalg','RSA','-keysize','2048','-dname','CN=Provider Fixture','-validity','2','-storetype','PKCS12','-keystore',key,'-storepass','test-only-password','-keypass','test-only-password','-noprompt'],{stdio:'pipe'});
  for(const role of ['server','client']){
    const dir=path.join(output,role+'-apk');fs.mkdirSync(dir);
    fs.copyFileSync(path.resolve('tests/fixtures/android-framework-services/manifests/remote-provider-'+role+'.xml.bin'),path.join(dir,'AndroidManifest.xml'));
    const apk=path.join(output,role+'-unsigned.apk');
    execFileSync(path.join(home,'bin/jar'),['--create','--file',apk,'-C',dir,'AndroidManifest.xml'],{stdio:'pipe'});
    execFileSync(path.join(home,'bin/java'),['-cp',cp,'SignApkSet',key,apk,path.join(output,role+'.apk')],{stdio:'pipe'});
  }
  const executable=path.join(output,'processes');execFileSync('clang',[path.resolve('tests/fixtures/android-native/BinderRpcJavaProcesses.c'),'-o',executable],{stdio:'pipe'});
  const identity=await require('../src/modules/android/process-channel').processNamespace(output,1);
  const child=spawn(executable,[path.join(home,'bin/java'),cp,path.resolve(runtime),output,'maclauncher.android.framework.RemoteContentProviderProbe'],{detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,...identity.environment,TMPDIR:output,JDK_JAVA_OPTIONS:require('../src/modules/android/jvm-options').frameworkJvmOptions.join(' ')}});
  let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
  const cleanup=()=>{try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}};
  t.after(cleanup);const deadline=setTimeout(cleanup,30000);
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(deadline));
  assert.equal(result.code,0,JSON.stringify(result)+'\n'+stdout+'\n'+stderr);
  assert.match(stdout,/PASS provider context and lifecycle: overridden Application package, original manifest context, disabled flags, initOrder, content-service lease and retained ActivityThread ownership/);
  assert.match(stdout,/PASS remote original providers: failed startup preserves ActivityManager, delayed publication, signed permissions, bulk cursor, descriptors, release\/reacquire and peer death/);
});
