const fs=require('fs'),path=require('path'),{spawn}=require('child_process'),{once}=require('events');
const repo=path.resolve(__dirname,'../../..');
const [java,runtime,preparedFile,clientApk,root]=process.argv.slice(2);
if(!root)throw Error('Expected Java, runtime, prepared service, signed client APK and private output');
for(const role of ['client','service'])for(const part of ['files','cache','native','assets','resources','classes'])fs.mkdirSync(path.join(root,role,'data',part),{recursive:true});
const Supervisor=require(path.join(repo,'src/modules/android/service-processes'));
const Sandbox=require(path.join(repo,'src/modules/android/sandbox'));
const {frameworkJvmOptions}=require(path.join(repo,'src/modules/android/jvm-options'));
const cp=[runtime+'/android-host.jar',runtime+'/android-framework.jar'];
const {spawnSync}=require('child_process');
const compiled=spawnSync(path.join(path.dirname(java),'javac'),['--release','21','-cp',cp.join(path.delimiter),'-d',root+'/client/data/classes',path.join(repo,'tests/fixtures/android-framework-services/InstalledServiceClient.java'),path.join(repo,'tests/fixtures/android-window-session/RuntimeFixture.java')],{encoding:'utf8',timeout:15000});
if(compiled.status!==0)throw Error(compiled.stdout+compiled.stderr);
const record=JSON.parse(fs.readFileSync(preparedFile)),old=record.prepared||record;
const service={...old,filesRoot:root+'/service/data/files',cacheRoot:root+'/service/data/cache'};
const clientMetadata=require(path.join(repo,'src/modules/android/apk')).inspectApk(clientApk);
const gameSource={...clientMetadata,sourceApk:clientApk};
const game={metadata:{packageName:gameSource.packageName,applicationProcessName:gameSource.packageName},sourceApk:gameSource.sourceApk,convertedJar:runtime+'/android-host.jar',nativeRoot:root+'/client/data/native',assetsRoot:root+'/client/data/assets',resourcesRoot:root+'/client/data/resources',filesRoot:root+'/client/data/files',cacheRoot:root+'/client/data/cache'};
const makeConfig=p=>({schemaVersion:1,runtimeRoot:runtime,packageName:p.metadata.packageName,versionName:p.metadata.versionName||'1',versionCode:p.metadata.versionCode||1,convertedJar:p.convertedJar,nativeRoot:p.nativeRoot,assetsRoot:p.assetsRoot,resourcesRoot:p.resourcesRoot,sourceApk:p.sourceApk,filesRoot:p.filesRoot,cacheRoot:p.cacheRoot,title:p.metadata.packageName,width:960,height:600,webLinksAllowed:0,networkAllowed:0});
const config={...makeConfig(game),activityClass:'maclauncher.android.HostWindowProbe$OwnedActivity'};
const children=[];let supervisor;const abort=new AbortController();const timer=setTimeout(()=>{abort.abort(new Error('Owned service proof deadline'));for(const child of children)if(child.exitCode==null&&child.signalCode==null)try{process.kill(-child.pid,'SIGKILL');}catch{}},30000);
async function launch(role,conf,stdio,sandbox,entry,extra=[]){
 const configFile=root+'/'+role+'/launch.json';fs.writeFileSync(configFile,JSON.stringify(conf)+'\n');
 const isolated=await Sandbox.prepareSandbox({javaPath:java,config:conf,configFile,dataRoot:root+'/'+role+'/data',blockNetwork:true,...sandbox});
 const args=[...isolated.prefix,...isolated.javaArguments,...frameworkJvmOptions,'-XstartOnFirstThread','-cp',(role==='client'?[root+'/client/data/classes',...cp]:cp).join(path.delimiter),entry,...extra,configFile];
 if(role==='client')args.splice(args.length-1,1,configFile,'com.google.android.gms','org.microg.gms.gcm.PushRegisterService','com.google.android.c2dm.intent.REGISTER');
 const child=spawn(isolated.command,args,{stdio:stdio.map((x,i)=>i===1?'pipe':x),env:isolated.environment,detached:true,cwd:conf.filesRoot});children.push(child);
 for(const [key,index] of [['stdout',1],['stderr',2]]){const out=fs.createWriteStream(root+'/'+role+'/'+key+'.log');child.stdio[index]?.pipe(out);}
 await once(child,'spawn');return child;
}
(async()=>{try{
 supervisor=await Supervisor.prepareConnections({descriptorSender:path.join(runtime,"native/android-supervisor-send"),installed:{uid:10000,services:[{record:{packageName:'com.google.android.gms',processName:'com.google.android.gms:persistent',uid:10001,firstInstallTime:1,lastUpdateTime:1},prepared:service}],release:async()=>{}},game,config,signal:abort.signal,logger:console,
 launchService:async(s,fields,stdio,sandbox)=>launch('service',{...makeConfig(s.prepared),...fields},stdio,sandbox,'maclauncher.android.ServiceHost',['--config'])});
 const client=await launch('client',config,supervisor.stdio(['ignore','pipe','pipe','ignore']),supervisor.sandbox,'maclauncher.android.InstalledServiceClient');
 await supervisor.connect(client);const [status,signal]=await once(client,'exit');console.log(JSON.stringify({status,signal}));if(status)process.exitCode=1;
}catch(error){console.error(error);process.exitCode=1;}finally{clearTimeout(timer);if(supervisor)await supervisor.close();for(const child of children)if(child.exitCode!==0){console.error('Owned process did not exit normally',child.pid,child.exitCode,child.signalCode);process.exitCode=1;}for(const child of children)if(child.exitCode==null&&child.signalCode==null)try{process.kill(-child.pid,'SIGKILL');}catch{}}})();
