const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
const {paths}=require('../src/modules/android/platform-services/paths');
const {startProfileService}=require('../src/modules/android/platform-services/jvm');
const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');

test('authenticated native service scopes share original audio permission state and retire independently',{timeout:60000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'android-service-scopes-'))),storage=await paths(root,'system'),children=new Set();
 let service,lock;
 t.after(async()=>{for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL');await service?.close();await lock?.close();await fs.rm(root,{recursive:true,force:true});await fs.rm(storage.runRoot,{recursive:true,force:true});});
 const privateRuntime=path.join(root,'runtime'),classes=path.join(root,'classes');await fs.mkdir(classes);
 await fs.cp(runtime,privateRuntime,{recursive:true,dereference:true,mode:require('node:fs').constants.COPYFILE_FICLONE,
  filter:file=>!['build','source','build-source.json','build-receipt.json'].includes(path.relative(runtime,file).split(path.sep)[0])});
 const cp=['android-host.jar','android-framework.jar'].map(file=>path.join(privateRuntime,file)).join(path.delimiter);
 const sources=['PlatformServiceHost','framework/HostServices','framework/HostServiceDirectory','framework/HostProcessServices','framework/HostAudioPermissions'];
 execFileSync(home+'/bin/javac',['--release','21','-cp',cp,'-d',classes,...sources.map(name=>path.resolve('src/modules/android/native/java/maclauncher/android/'+name+'.java')),'tests/fixtures/android-platform-service/AudioScopeProbe.java']);
 execFileSync(home+'/bin/jar',['--update','--file',path.join(privateRuntime,'android-host.jar'),'-C',classes,'.']);
 lock=await fs.open(storage.lock,'w',0o600);
 service=await startProfileService({userDataDir:root,runtimeRoot:privateRuntime,javaPath:home+'/bin/java',moduleRoot:path.resolve('src/modules/android'),role:'system'},storage,lock.fd);await service.ready;
 async function client(name,uid=1000){
  const child=spawn(home+'/bin/java',[...frameworkJvmOptions,'-cp',cp,'maclauncher.android.AudioScopeProbe',privateRuntime,path.join(root,name),service.socketPath,String(service.identity.pid),String(uid)],{stdio:['pipe','pipe','pipe']});children.add(child);
  let stdout='',stderr='',tail='';const lines=[],waiters=[];const completed=once(child,'close');
  child.stderr.on('data',bytes=>stderr+=bytes);child.stdout.on('data',bytes=>{stdout+=bytes;tail+=bytes;let end;while((end=tail.indexOf('\n'))>=0){const line=tail.slice(0,end).trim();tail=tail.slice(end+1);if(/^(READY|OK|COUNTS )/.test(line)){if(waiters.length)waiters.shift().resolve(line);else lines.push(line);}}});
  child.once('close',()=>{children.delete(child);for(const waiter of waiters.splice(0))waiter.reject(Error(stdout+'\n'+stderr));});
  const next=()=>lines.length?Promise.resolve(lines.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject}));
  assert.equal(await next(),'READY');
  const peer={packageName:uid===1000?'android':'fixture.client',processName:name,pid:child.pid,uid,hostUid:process.getuid(),securityContext:uid===1000?'u:r:system_server:s0':'u:r:untrusted_app:s0'};
  await service.enroll(peer);
  const result={child,peer,async command(command){child.stdin.write(command+'\n');const result=await next();if(command==='snapshot')return result.split(' ').slice(1).map(Number);assert.equal(result,'OK');},async close(){await this.command('stop');const [code,signal]=await completed;assert.equal(code,0,signal+'\n'+stdout+'\n'+stderr);await service.retire(peer);}};
  await result.command('connect');return result;
 }
 const first=await client('android.composition.first'),second=await client('android.composition.second');
 await first.command('publish');const before=await first.command('snapshot');await second.command('publish');await first.command('check');await second.command('check');
 const after=await first.command('snapshot');assert.ok(after[0]>before[0]&&after[1]>before[1],'A new native destination replays the single original permission provider to both live endpoints');
 const denied=await client('fixture.client',10031);await denied.command('denied');await denied.close();
 await first.close();await second.command('check');await second.command('unregister');await second.command('publish');await second.command('check');await second.close();
 assert.equal(service.child.exitCode,null,'Retiring one composition does not stop the canonical profile owner');
});
