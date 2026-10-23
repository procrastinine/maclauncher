const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

test('original Android v1 APK signatures use JDK cryptography and reject changed entries',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-v1-signature-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const cp=[output,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,path.resolve('tests/fixtures/android-framework-services/V1SignatureProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],{stdio:'pipe'});
  const key=path.join(output,'signer.p12'),apk=path.join(output,'signed.apk'),bad=path.join(output,'modified.apk');
  fs.copyFileSync(path.resolve('tests/fixtures/android-framework-services/manifests/remote-provider-client.xml.bin'),path.join(output,'AndroidManifest.xml'));
  fs.writeFileSync(path.join(output,'payload'),'original content');
  execFileSync(path.join(home,'bin/keytool'),['-genkeypair','-alias','fixture','-keyalg','RSA','-keysize','2048','-dname','CN=APK Fixture','-validity','2','-storetype','PKCS12','-keystore',key,'-storepass','test-only-password','-keypass','test-only-password','-noprompt'],{stdio:'pipe'});
  execFileSync(path.join(home,'bin/jar'),['--create','--file',apk,'-C',output,'AndroidManifest.xml','-C',output,'payload'],{stdio:'pipe'});
  execFileSync(path.join(home,'bin/jarsigner'),['-keystore',key,'-storepass','test-only-password',apk,'fixture'],{stdio:'pipe'});
  fs.copyFileSync(apk,bad);fs.writeFileSync(path.join(output,'payload'),'modified content');
  execFileSync(path.join(home,'bin/jar'),['--update','--file',bad,'-C',output,'payload'],{stdio:'pipe'});
  const result=execFileSync(path.join(home,'bin/java'),[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Xverify:all','-cp',cp,'V1SignatureProbe',path.resolve(runtime),output,apk,bad],{encoding:'utf8',timeout:20000,env:{...process.env,TMPDIR:output}});
  assert.match(result,/PASS original Android v1 signer verification and changed-entry rejection/);
});
