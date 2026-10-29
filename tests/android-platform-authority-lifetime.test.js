const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process'),{once}=require('node:events');
const {paths}=require('../src/modules/android/platform-services/paths');
const {startProfileService}=require('../src/modules/android/platform-services/jvm');

test('a retired or invalid lifecycle request cannot terminate other profile service clients',{timeout:45000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'android-authority-lifetime-'))),storage=await paths(root,'system');
 const privateRuntime=path.join(root,'runtime'),classes=path.join(root,'classes');await fs.mkdir(classes);
 let service,completed,lock;
 t.after(async()=>{service?.close();if(service?.child.exitCode==null&&service?.child.signalCode==null){const timer=setTimeout(()=>service.child.kill('SIGKILL'),5000);await completed;clearTimeout(timer);}await lock?.close();await fs.rm(root,{recursive:true,force:true});await fs.rm(storage.runRoot,{recursive:true,force:true});});
 await fs.cp(runtime,privateRuntime,{recursive:true,dereference:true,mode:require('node:fs').constants.COPYFILE_FICLONE,
  filter:file=>!['build','source','build-source.json','build-receipt.json'].includes(path.relative(runtime,file).split(path.sep)[0])});
 const cp=['android-host.jar','android-framework.jar'].map(file=>path.join(privateRuntime,file)).join(path.delimiter);
 execFileSync(home+'/bin/javac',['--release','21','-cp',cp,'-d',classes,...['ProcessAuthority','framework/HostContext'].map(name=>path.resolve('src/modules/android/native/java/maclauncher/android/'+name+'.java'))]);
 execFileSync(home+'/bin/jar',['--update','--file',path.join(privateRuntime,'android-host.jar'),'-C',classes,'.']);
 lock=await fs.open(storage.lock,'w',0o600);
 service=await startProfileService({userDataDir:root,runtimeRoot:privateRuntime,runtimeIdentity:require('./helpers/android-java').runtimeIdentity(privateRuntime),javaPath:home+'/bin/java',moduleRoot:path.resolve('src/modules/android'),role:'system'},storage,lock.fd);
 let detail='';service.child.stderr.on('data',bytes=>{detail=(detail+bytes).slice(-16384);});completed=once(service.child,'close');
 await service.ready;
 // Identity protocol 1 peers carry a leased Android PID and their physical owner.
 const peer={packageName:'example.lifecycle',processName:'example.lifecycle',pid:4242,hostPid:process.pid,uid:10031,hostUid:process.getuid(),securityContext:'u:r:untrusted_app:s0'};
 await service.enroll(peer);await service.processState(peer,2);await service.retire(peer);
 await assert.rejects(service.processState(peer,19),error=>error.failureType==='java.lang.SecurityException',detail);
 await service.enroll(peer);
 await assert.rejects(service.enroll({...peer,pid:peer.pid+1},{packages:[]}),error=>error.failureType==='java.lang.SecurityException',detail);
 await assert.rejects(service.processState(peer,20),error=>error.failureType==='java.lang.IllegalArgumentException',detail);
 await service.processState(peer,2);await service.retire(peer);
 assert.equal(service.child.exitCode,null,'The original profile service remains alive after rejected requests');
 service.close();const [code,signal]=await completed;assert.equal(code,0,signal+'\n'+detail);
});
