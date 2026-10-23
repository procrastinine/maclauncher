const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('original URI grant service retains permission policy and private durable ownership',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires real native runtime and JDK21');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-uri-grants-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const source=path.resolve('src/modules/android/native'),fixture=path.resolve('tests/fixtures/android-framework-services'),framework=path.resolve(runtime,'android-framework.jar');
 const asm=JSON.parse(fs.readFileSync(path.join(source,'asm-binary.json'))).files.map(f=>path.join(source,'tools',f.path));
 const cp=[temp,...asm,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'apksig.jar'),framework].join(path.delimiter);
 function run(name,args){const r=spawnSync(path.join(home,'bin',name),args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20});assert.equal(r.error,undefined,[r.error?.message,r.stdout,r.stderr].filter(Boolean).join('\n'));assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;}
 run('javac',['--release','21','-cp',cp,'-d',temp,path.join(fixture,'SignApkSet.java')]);
 const key=path.join(temp,'signer.p12');run('keytool',['-genkeypair','-alias','owned','-keyalg','RSA','-keysize','2048','-dname','CN=URI Grant Fixture','-validity','2','-storetype','PKCS12','-keystore',key,'-storepass','test-only-password','-keypass','test-only-password','-noprompt']);
 for(const [name,manifest]of[['provider','uri-grants'],['client','remote-provider-client']]){
  const dir=path.join(temp,name);fs.mkdirSync(dir);fs.copyFileSync(path.join(fixture,'manifests',manifest+'.xml.bin'),path.join(dir,'AndroidManifest.xml'));
  const unsigned=path.join(temp,name+'-unsigned.apk');run('jar',['--create','--file',unsigned,'-C',dir,'AndroidManifest.xml']);
  run('java',['-cp',cp,'SignApkSet',key,unsigned,path.join(temp,name+'.apk')]);
 }
 if(process.env.ANDROID_STATSD_SOURCE){
  const selected=fs.globSync('service/java/**/*.java',{cwd:process.env.ANDROID_STATSD_SOURCE}).map(file=>path.join(process.env.ANDROID_STATSD_SOURCE,file));
  run('javac',['--release','21','-cp',cp,'-d',temp,...selected]);
 }
 run('javac',['--release','21','-cp',cp,'-d',temp,path.join(source,'framework/ServicePortability.java'),path.join(source,'framework/PendingIntentCalls.java'),...['HostStats','HostUriGrants','HostActivityManager','HostPackages','HostAccountAccess'].map(n=>path.join(source,'java/maclauncher/android/framework',n+'.java')),...['UriGrantsTransform','UriGrantsProbe'].map(n=>path.join(fixture,n+'.java')),path.join(fixture,'../android-window-session/RuntimeFixture.java')]);
 run('java',['-cp',cp,'UriGrantsTransform',framework,temp]);
 assert.match(run('java',['-Xverify:all','-cp',cp,'UriGrantsProbe',path.resolve(runtime),temp]),/PASS complete original URI grant owner, UID\/path\/mode isolation, persistence and revocation/);
 assert.match(run('java',['-Xverify:all','-cp',cp,'UriGrantsProbe',path.resolve(runtime),temp,'restore']),/PASS original URI grants restore after owner restart/);
});
