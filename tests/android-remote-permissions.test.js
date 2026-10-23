const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
const {paths}=require('../src/modules/android/platform-services/paths');
const {startProfileService}=require('../src/modules/android/platform-services/jvm');
const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');

test('native permission clients query enrolled app owners and retire reverse directory leases',{timeout:60000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'android-remote-permissions-'))),storage=await paths(root,'system'),children=new Set();let service,lock;
 t.after(async()=>{for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL');await service?.close();await lock?.close();await fs.rm(root,{recursive:true,force:true});await fs.rm(storage.runRoot,{recursive:true,force:true});});
 const privateRuntime=path.join(root,'runtime'),classes=path.join(root,'classes');await fs.mkdir(classes);
 await fs.cp(runtime,privateRuntime,{recursive:true,dereference:true,mode:require('node:fs').constants.COPYFILE_FICLONE,filter:file=>!['build','source','build-source.json','build-receipt.json'].includes(path.relative(runtime,file).split(path.sep)[0])});
 const cp=['android-host.jar','android-framework.jar'].map(file=>path.join(privateRuntime,file)).join(path.delimiter),source=path.resolve('src/modules/android/native/java/maclauncher/android');
 const changed=['PlatformServiceHost','framework/HostProcessServices','framework/HostServiceDirectory','framework/HostRemoteServices','framework/HostPermissions','framework/HostPackages','framework/HostContextServices'];
 execFileSync(home+'/bin/javac',['--release','21','-cp',cp,'-d',classes,...changed.map(name=>path.join(source,name+'.java')),'tests/fixtures/android-platform-service/RemotePermissionProbe.java','tests/fixtures/android-framework-services/PackageManifest.java']);
 execFileSync(home+'/bin/jar',['--update','--file',path.join(privateRuntime,'android-host.jar'),'-C',classes,'.']);
 const prepared=path.join(root,'android/apps/fixture/prepared');await fs.mkdir(prepared,{recursive:true});const apk=path.join(prepared,'app.apk');
 await fs.copyFile('tests/fixtures/android-framework-services/manifests/permissions.xml.bin',path.join(prepared,'AndroidManifest.xml'));
 execFileSync(home+'/bin/jar',['--create','--file',apk+'.unsigned','-C',prepared,'AndroidManifest.xml']);
 const key=path.join(root,'signer.p12'),signer=classes+path.delimiter+path.resolve('src/modules/android/native/tools/apksig.jar');
 execFileSync(home+'/bin/keytool',['-genkeypair','-alias','owned','-keyalg','RSA','-keysize','2048','-dname','CN=Permission Fixture','-validity','2','-storetype','PKCS12','-keystore',key,'-storepass','test-only-password','-keypass','test-only-password','-noprompt'],{stdio:'pipe'});
 execFileSync(home+'/bin/javac',['-cp',signer,'-d',classes,'tests/fixtures/android-framework-services/SignApkSet.java']);
 execFileSync(home+'/bin/java',['-cp',signer,'SignApkSet',key,apk+'.unsigned',apk]);await fs.rm(apk+'.unsigned');
 lock=await fs.open(storage.lock,'w',0o600);service=await startProfileService({userDataDir:root,runtimeRoot:privateRuntime,javaPath:home+'/bin/java',moduleRoot:path.resolve('src/modules/android'),role:'system'},storage,lock.fd);await service.ready;
 async function client(role){
  const data=path.join(root,role);await fs.mkdir(data);
  const child=spawn(home+'/bin/java',[...frameworkJvmOptions,'-cp',cp,'maclauncher.android.framework.RemotePermissionProbe',privateRuntime,data,service.socketPath,String(service.identity.pid),apk,role],{stdio:['pipe','pipe','pipe']});children.add(child);
  let stdout='',stderr='',tail='';const lines=[],waiters=[],completed=once(child,'close');child.stderr.on('data',bytes=>stderr+=bytes);
  child.stdout.on('data',bytes=>{stdout+=bytes;tail+=bytes;let end;while((end=tail.indexOf('\n'))>=0){const line=tail.slice(0,end).trim();tail=tail.slice(end+1);if(/^(READY|OK)$/.test(line)){if(waiters.length)waiters.shift().resolve(line);else lines.push(line);}}});
  child.once('close',()=>{children.delete(child);for(const waiter of waiters.splice(0))waiter.reject(Error(stdout+'\n'+stderr));});
  const next=()=>lines.length?Promise.resolve(lines.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject}));assert.equal(await next(),'READY');
  const app=role.startsWith('app'),peer={packageName:app?'org.example.permissions':'android',processName:app?'org.example.permissions':'android.permission-fixture',pid:child.pid,uid:app?10031:1000,hostUid:process.getuid(),securityContext:app?'u:r:untrusted_app:s0':'u:r:system_server:s0'};
  const packages=app?[{packageName:peer.packageName,uid:peer.uid,sourceApks:[apk],dataRoot:data,nativeRoot:path.join(privateRuntime,'native'),firstInstallTime:1,lastUpdateTime:1}]:undefined;
  await service.enroll(peer,packages?{packages}:undefined);
  const result={child,peer,async command(command){child.stdin.write(command+'\n');assert.equal(await next(),'OK');},async close(){await this.command('stop');const [code,signal]=await completed;assert.equal(code,0,signal+'\n'+stdout+'\n'+stderr);await service.retire(peer);}};
  await result.command('connect');return result;
 }
 const app=await client('app'),native=await client('native');
 await app.command('denied');await native.command('denied');await app.command('grant');await native.command('granted');
 await Promise.all([app.command('barrier'),native.command('barrier')]);await app.command('revoke');await native.command('denied');await native.command('unauthorized');
 await app.close();const replacement=await client('app-replacement');await replacement.command('grant');await native.command('granted');await replacement.close();
 await native.command('denied');await native.command('barrier');await native.close();assert.equal(service.child.exitCode,null,'App retirement does not stop the shared owner');
});
