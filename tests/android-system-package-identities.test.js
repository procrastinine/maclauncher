const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync,spawn}=require('node:child_process');
const {once}=require('node:events');

test('Original package identities and direct shared process directories preserve callers across JVMs',{timeout:40000},async t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME');
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-system-packages-')));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const root=path.resolve(runtime),cp=[temp,path.join(root,'android-host.jar'),path.join(root,'android-framework.jar')].join(path.delimiter);
  const tools=path.resolve('src/modules/android/native/tools/*');
  execFileSync(path.join(home,'bin/javac'),['-cp',tools,'-d',temp,path.resolve('src/modules/android/native/framework/PackageIdentityRules.java')]);
  execFileSync(path.join(home,'bin/java'),['-cp',temp+path.delimiter+tools,'PackageIdentityRules',path.join(root,'android-framework.jar'),path.join(temp,'maclauncher/android/framework/shared-users.tsv')]);
  const source='src/modules/android/native/java/';
  execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temp,
    ...['com/android/server/pm/HostPackageIdentities','maclauncher/android/RuntimeBootstrap','maclauncher/android/HostDigests',
      ...['HostPackages','HostProcessServices','HostServiceDirectory','HostRemoteServices'].map(name=>'maclauncher/android/framework/'+name)].map(name=>path.resolve(source,name+'.java')),
    path.resolve('tests/fixtures/android-package-metadata/PackageIdentityProbe.java'),path.resolve('tests/fixtures/android-process-authority/SystemDirectoryProbe.java'),
    path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java'),path.resolve('tests/fixtures/android-framework-services/SyntheticResources.java')]);
  const jvm=require('../src/modules/android/jvm-options').frameworkJvmOptions;
  const certs=fs.readdirSync(path.join(root,'android-root/system/etc/security/cacerts')).filter(name=>name.endsWith('.0')).slice(0,2);
  assert.equal(certs.length,2);
  const result=execFileSync(path.join(home,'bin/java'),[...jvm,'-cp',cp,'maclauncher.android.PackageIdentityProbe',root,path.join(temp,'identities'),...certs.map(name=>path.join(root,'android-root/system/etc/security/cacerts',name))],{encoding:'utf8',timeout:15000});
  assert.match(result,/PASS original UID allocation/);
  const children=[];
  const launch=(role,uid)=>{
    const data=fs.mkdtempSync(path.join(temp,role+'-'));
    const child=spawn(path.join(home,'bin/java'),[...jvm,'-cp',cp,'maclauncher.android.SystemDirectoryProbe',root,data,role,String(uid),String(process.getuid()),path.join(temp,'binder')],{stdio:['pipe','pipe','pipe']});
    child.output='';child.errors='';child.stdout.on('data',data=>child.output+=data);child.stderr.on('data',data=>child.errors+=data);children.push(child);return child;
  };
  const wait=async(child,text)=>{const deadline=Date.now()+12000;while(!child.output.includes(text)){assert.equal(child.exitCode,null,child.errors);assert.ok(Date.now()<deadline,child.output+child.errors);await new Promise(resolve=>setTimeout(resolve,10));}};
  try{
    const server=launch('server',10030);await wait(server,'READY');
    const clients=[launch('client',10041),launch('client',10042)];
    await Promise.all(clients.map(client=>wait(client,'READY')));
    for(let i=0;i<clients.length;i++){
      const client=clients[i],peer={packageName:'example.client'+i,processName:'example.client'+i,pid:client.pid,uid:10041+i};
      server.stdin.write(JSON.stringify(peer)+'\n');await wait(server,'ENROLLED '+client.pid);
      client.stdin.write(JSON.stringify({packageName:'example.system',processName:'example.system',pid:server.pid,uid:10030})+'\n');
    }
    await Promise.all(clients.map((client,i)=>wait(client,'PASS '+(10041+i))));
    for(const child of clients){const ended=once(child,'exit');child.stdin.end();assert.equal((await ended)[0],0,child.errors);}
    const ended=once(server,'exit');server.stdin.end();assert.equal((await ended)[0],0,server.errors);
  }finally{for(const child of children)if(child.exitCode==null&&child.signalCode==null){child.kill('SIGKILL');await once(child,'close');}}
});

test('Signed packages sharing an Android UID and process retain separate original applications',{timeout:30000},t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME,aapt2=process.env.AAPT2;
  if(process.platform!=='darwin'||!runtime||!home||!aapt2)return t.skip('Requires macOS, JAVA_HOME, AAPT2 and KLEPTON_NATIVE_RUNTIME');
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-shared-apps-')));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const root=path.resolve(runtime),cp=[temp,path.join(root,'android-host.jar'),path.join(root,'android-framework.jar')].join(path.delimiter);
  const run=(name,args,options={})=>execFileSync(path.join(home,'bin',name),args,{encoding:'utf8',stdio:'pipe',...options});
  run('javac',['--release','21','-cp',cp,'-d',temp,...[
    'com/android/server/compat/HostPlatformCompat','com/android/server/pm/HostPackageIdentities','maclauncher/android/PackageMetadataMain',...['PackageMetadata','HostPackages','HostApplication','HostLocalServices','HostActivity','HostActivityTasks','HostActivityService','HostProcessServices','HostProviderConnections','HostVmDebug'].map(name=>'maclauncher/android/framework/'+name)
  ].map(name=>path.resolve('src/modules/android/native/java',name+'.java')),path.resolve('tests/fixtures/android-package-metadata/SharedPackageProcessProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')]);
  const transformCp=cp+path.delimiter+path.resolve('src/modules/android/native/tools/*');
  run('javac',['-cp',transformCp,'-d',temp,path.resolve('src/modules/android/native/framework/NativeBindings.java'),path.resolve('tests/fixtures/android-package-metadata/VmDebugTransform.java')]);
  run('java',['-cp',transformCp,'VmDebugTransform',path.join(root,'android-framework.jar'),temp]);
  const key=path.join(temp,'signer.p12');
  run('keytool',['-genkeypair','-alias','fixture','-keyalg','RSA','-keysize','2048','-dname','CN=Shared APK Fixture','-validity','2','-storetype','PKCS12','-keystore',key,'-storepass','test-only-password','-keypass','test-only-password','-noprompt']);
  const apks=[];
  for(const name of ['first','second']){
    const manifest=path.join(temp,name+'.xml'),apk=path.join(temp,name+'.apk');
    fs.writeFileSync(manifest,`<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="fixture.${name}" android:sharedUserId="fixture.shared"><uses-sdk android:minSdkVersion="21" android:targetSdkVersion="28"/><application android:hasCode="false" android:process="fixture.shared"><service android:name="maclauncher.android.framework.SharedPackageProcessProbe$SecondService" android:exported="false"/></application></manifest>`);
    execFileSync(aapt2,['link','-I',path.join(root,'android-framework.jar'),'--manifest',manifest,'-o',apk],{stdio:'pipe'});
    run('jarsigner',['-keystore',key,'-storepass','test-only-password',apk,'fixture']);apks.push(apk);
  }
  fs.mkdirSync(path.join(temp,'metadata'));
  const identities=run('java',[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-cp',cp,'maclauncher.android.PackageMetadataMain',root,path.join(temp,'metadata')],{
    input:apks.map((apk,index)=>JSON.stringify({id:index+1,operation:'identity',sources:[apk]})).join('\n')+'\n',timeout:15000});
  const replies=identities.split('\n').filter(line=>line.startsWith('[android-package-metadata]')).map(line=>JSON.parse(line.slice('[android-package-metadata]'.length)));
  assert.equal(replies.length,2);for(const reply of replies){assert.equal(reply.error,undefined);assert.equal(reply.result.sharedUserId,'fixture.shared');assert.equal(reply.result.signing.current.length,1);}
  assert.deepEqual(replies[0].result.signing,replies[1].result.signing,'The actual original verifier returns the same signer for both packages');
  const output=run('java',[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-cp',cp,'maclauncher.android.framework.SharedPackageProcessProbe',root,path.join(temp,'data'),...apks,String(process.getuid())],{timeout:15000});
  assert.match(output,/PASS shared process applications, service context, UID isolation and one directory demand/);
});
