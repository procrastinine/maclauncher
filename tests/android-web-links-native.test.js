const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('./helpers/android-java');
const fixtures=path.join(__dirname,'fixtures/android-native');
function javaHome(){if(process.env.JAVA_HOME&&fs.existsSync(path.join(process.env.JAVA_HOME,'bin/javac')))return process.env.JAVA_HOME;if(process.platform!=='darwin')return null;const result=spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'});return result.status===0?result.stdout.trim():null;}
function run(command,args,options={}){const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:1<<20,...options});assert.equal(result.error,undefined);assert.equal(result.status,0,String(result.stdout)+String(result.stderr));assert.doesNotMatch(String(result.stderr),/WARNING in native method|FATAL ERROR|WARNING: JNI/);return result;}
test('Android web-link URL parsing retains internationalized hostnames with explicit ports',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;if(!home||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-link-url-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  run(home+'/bin/javac',['--release','21','-cp',cp,'-d',temporary,'src/modules/android/native/java/maclauncher/android/bridge/WebLinks.java',path.join(fixtures,'web-links/android/content/Intent.java'),path.join(fixtures,'WebLinkUrlProbe.java')]);
  const result=run(home+'/bin/java',['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.bridge.WebLinkUrlProbe']);
  assert.match(result.stdout,/PASS JDK web-link parsing preserves international host ports, IPv6 and rejected authorities/);
});
test('Android web-link JNI sends bounded requests and closes its inherited descriptor without opening a browser',async t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;if(process.platform!=='darwin'||!home||!runtime)return t.skip('Requires macOS, Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-web-links-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const library=path.resolve(runtime,'native/libklepton-jvm.dylib');
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  const namespace=await require('../src/modules/android/process-channel').processNamespace(temporary,1);
  run(home+'/bin/javac',['--release','21','-cp',cp,'-d',temporary,'src/modules/android/native/java/maclauncher/android/bridge/WebLinks.java',path.join(fixtures,'WebLinksProbe.java'),'tests/fixtures/android-window-session/RuntimeFixture.java']);
  for(const policy of ['allow','deny','unavailable']){
    const result=run(home+'/bin/java',[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Xverify:all','-Xcheck:jni','-cp',temporary+path.delimiter+cp,'WebLinksProbe',library,policy,path.join(temporary,policy)],{env:{...process.env,...namespace.environment},encoding:null,stdio:['ignore','pipe','pipe',policy==='unavailable'?'ignore':'pipe']});
    assert.match(String(result.stdout),/PASS validated web-link/);
    const bytes=result.output[3]||Buffer.alloc(0),urls=[];let offset=0;
    if(policy==='unavailable')assert.match(String(result.stderr),/Web-link request channel is unavailable/);
    while(offset<bytes.length){assert.ok(bytes.length-offset>=2);const length=bytes.readUInt16BE(offset);offset+=2;assert.ok(length>0&&length<=8192&&offset+length<=bytes.length);urls.push(bytes.subarray(offset,offset+length).toString('utf8'));offset+=length;}
    assert.equal(urls.length,policy==='allow'?9:0);
    if(policy==='allow')assert.deepEqual(urls,['https://example.invalid/page?value=one#part','https://example.invalid/%E8%B3%87%E6%96%99%F0%9F%8E%AE','https://example.invalid/package','https://example.invalid/component','https://example.invalid/type','https://example.invalid/category','https://%E4%BE%8B%E3%81%88.%E3%83%86%E3%82%B9%E3%83%88:8443/privacy','https://b%C3%BCcher.example:443/help','https://[::1]:8443/help']);
  }
});

test('Android activity resolution retains the original destination before HTTP(S) fallback',async t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;if(process.platform!=='darwin'||!home||!runtime)return t.skip('Requires macOS, Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-browser-resolution-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),source=path.join(__dirname,'fixtures/android-framework-services');
  run(home+'/bin/javac',['--release','21','-cp',cp,'-d',temporary,'src/modules/android/native/java/maclauncher/android/bridge/WebLinks.java',...['BrowserActivityResolutionProbe','SyntheticResources','PackageManifest'].map(name=>path.join(source,name+'.java')),'tests/fixtures/android-window-session/RuntimeFixture.java']);
  const namespace=await require('../src/modules/android/process-channel').processNamespace(temporary,1);
  const result=run(home+'/bin/java',[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.BrowserActivityResolutionProbe',path.resolve(runtime),temporary],{env:{...process.env,...namespace.environment},encoding:null,stdio:['ignore','pipe','pipe','pipe']});
  assert.match(String(result.stdout),/PASS original Android activity resolution precedes the browser fallback/);
  assert.equal(result.output[3].length,0,'An installed Android activity must not request the Mac browser');
});
