const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Original SensorPrivacy service starts with the system owner and retains state/listener ownership',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'android-sensor-privacy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source=path.resolve('src/modules/android/native'),cp=['android-host.jar','android-framework.jar'].map(f=>path.resolve(runtime,f)).join(path.delimiter);
 const run=(name,args)=>{const r=spawnSync(home+'/bin/'+name,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.equal(r.error,undefined,[r.error?.message,r.stdout,r.stderr].filter(Boolean).join('\n'));assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('javac',['--release','21','-cp',cp,'-d',dir,...['HostSensorPrivacy','HostSystemServices','HostUserService','HostAppOps','HostActivityManager','HostProcessServices','HostProcessInfo','HostTelephonyRegistry','HostAudioPermissions','HostAudioPolicy','HostPackages','HostPermissions','HostPowerService'].map(name=>source+'/java/maclauncher/android/framework/'+name+'.java'),source+'/java/maclauncher/android/media/HostAudioService.java',path.resolve('tests/fixtures/android-platform-service/SensorPrivacyProbe.java')]);
 const asm=JSON.parse(fs.readFileSync(source+'/asm-binary.json')).files.map(file=>path.join(source,'tools',file.path)).join(path.delimiter);
 run('javac',['--release','21','-cp',asm,'-d',dir,source+'/framework/ServicePortability.java',source+'/framework/PendingIntentCalls.java',path.resolve('tests/fixtures/android-platform-service/SensorPrivacyBindings.java')]);
 run('java',['-cp',[dir,asm,cp].join(path.delimiter),'SensorPrivacyBindings',path.resolve(runtime,'android-framework.jar'),dir]);
 for(const mode of ['write','read'])assert.match(run('java',['-Xverify:all','-cp',dir+path.delimiter+cp,'maclauncher.android.SensorPrivacyProbe',path.resolve(runtime),dir,mode]),/PASS original sensor privacy system boot/);
});
