const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');

test('package metadata avoids grant verification and requested permissions retain original signer policy without blocking local checks',{timeout:60000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires the complete Android runtime and Java21');
 const output=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-package-permission-flags-')));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const cp=[output,...['android-host.jar','android-framework.jar','apksig.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
 const identity=await require('../src/modules/android/process-channel').processNamespace(output,1);
 const run=(command,args)=>{const result=spawnSync(path.join(home,'bin',command),args,{encoding:'utf8',timeout:15000,maxBuffer:2<<20,env:{...process.env,...identity.environment,TMPDIR:output}});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const source=path.resolve('src/modules/android/native/java/maclauncher/android/framework');
 run('javac',['--release','21','-cp',cp,'-d',output,...['HostPackages','HostPermissions'].map(name=>path.join(source,name+'.java')),'tests/fixtures/android-package-metadata/PackagePermissionFlagsProbe.java','tests/fixtures/android-window-session/RuntimeFixture.java','tests/fixtures/android-framework-services/SignApkSet.java']);
 for(const role of ['client','server']){
  const directory=path.join(output,role);fs.mkdirSync(directory);fs.copyFileSync('tests/fixtures/android-framework-services/manifests/remote-provider-'+role+'.xml.bin',path.join(directory,'AndroidManifest.xml'));
  run('jar',['--create','--file',path.join(output,role+'-unsigned.apk'),'-C',directory,'AndroidManifest.xml']);
 }
 for(const name of ['publisher','foreign'])run('keytool',['-genkeypair','-alias','owned','-keyalg','RSA','-keysize','2048','-dname','CN=Package Fixture','-validity','2','-storetype','PKCS12','-keystore',path.join(output,name+'.p12'),'-storepass','test-only-password','-keypass','test-only-password','-noprompt']);
 run('java',['-cp',cp,'SignApkSet',path.join(output,'publisher.p12'),path.join(output,'client-unsigned.apk'),path.join(output,'client.apk'),path.join(output,'server-unsigned.apk'),path.join(output,'server.apk')]);
 run('java',['-cp',cp,'SignApkSet',path.join(output,'foreign.p12'),path.join(output,'server-unsigned.apk'),path.join(output,'foreign.apk')]);
 for(const mode of ['unsigned','signed','foreign','lock']){
  const client=path.join(output,mode==='unsigned'?'client-unsigned.apk':'client.apk'),server=path.join(output,mode==='foreign'?'foreign.apk':'server.apk');
  assert.match(run('java',['-Xverify:all','-cp',cp,'maclauncher.android.framework.PackagePermissionFlagsProbe',path.resolve(runtime),path.join(output,'data-'+mode),client,server,mode]),new RegExp('PASS package permission flags '+mode));
 }
});
