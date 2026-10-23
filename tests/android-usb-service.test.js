const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Original USB service owns discovery, defaults and persisted per-UID permissions',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'android-usb-service-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source=path.resolve('src/modules/android/native/java/maclauncher/android'),cp=['android-host.jar','android-framework.jar'].map(f=>path.resolve(runtime,f)).join(path.delimiter);
 const run=(name,args)=>{const r=spawnSync(home+'/bin/'+name,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.equal(r.error,undefined,[r.error?.message,r.stdout,r.stderr].filter(Boolean).join('\n'));assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('javac',['--release','21','-cp',cp,'-d',dir,path.resolve('src/modules/android/native/java/com/android/server/HostSchedulingPolicy.java'),...['framework/HostUsb.java','framework/HostSystemServices.java'].map(f=>path.join(source,f)),path.resolve('tests/fixtures/android-platform-service/UsbServiceProbe.java')]);
 const native=path.resolve('src/modules/android/native'),asm=JSON.parse(fs.readFileSync(native+'/asm-binary.json')).files.map(file=>path.join(native,'tools',file.path)).join(path.delimiter);
 run('javac',['--release','21','-cp',asm,'-d',dir,native+'/framework/ServicePortability.java',native+'/framework/PendingIntentCalls.java',path.resolve('tests/fixtures/android-platform-service/UsbPermissionBindings.java')]);
 run('java',['-cp',[dir,asm,cp].join(path.delimiter),'UsbPermissionBindings',path.resolve(runtime,'android-framework.jar'),dir]);
 for(const mode of ['write','read'])assert.match(run('java',['-Xverify:all','-cp',dir+path.delimiter+cp,'maclauncher.android.UsbServiceProbe',path.resolve(runtime),dir,mode]),/PASS original USB discovery and UID permission ownership/);
});
