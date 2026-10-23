const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('./helpers/android-java');

const source = path.resolve(__dirname, '../src/modules/android/native');
const fixtures = path.join(__dirname, 'fixtures/android-framework-services');
function javaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin/javac'))) return process.env.JAVA_HOME;
  if (process.platform !== 'darwin') return null;
  const result = spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
function run(executable, args, env, observe) {
  const result = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 << 20 });
  observe?.(result);
  assert.equal(result.error, undefined, [result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));
  assert.equal(result.signal, null, result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /WARNING in native method|FATAL ERROR in native method/);
  return result.stdout;
}
function javaFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? javaFiles(file) : entry.name.endsWith('.java') ? [file] : [];
  }).sort();
}

test('Window Settings startup reserves one directory without waiting for its publication',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-window-service-startup-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(source,'java/maclauncher/android/framework/HostRemoteServices.java'),path.join(fixtures,'WindowServiceStartupProbe.java')],process.env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.fixture.WindowServiceStartupProbe'],process.env),/PASS window Settings startup overlaps application setup with one authenticated directory and ordinary retirement/);
});

test('Lazy service factories cannot republish after their declaration retires',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-lazy-retirement-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  const identities=path.join(temporary,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(source,'java/maclauncher/android/framework/HostServices.java'),path.join(fixtures,'LazyServiceRetirementProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],env);
  const output=run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.fixture.LazyServiceRetirementProbe',path.resolve(runtime),temporary],env);
  assert.match(output,/PASS explicit lazy owner/);
  assert.match(output,/PASS retired lazy service cannot publish/);
});

test('Original widget service retains provider and binding behavior behind AppWidgetManager',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-widget-service-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  const identities=path.join(temporary,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(source,'java/com/android/server/appwidget/HostWidgetService.java'),path.join(source,'java/maclauncher/android/framework/HostSystemServices.java'),path.join(source,'java/maclauncher/android/framework/HostServices.java'),path.join(fixtures,'WidgetServiceProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.fixture.WidgetServiceProbe',path.resolve(runtime),temporary],env),/PASS original widget service and AppWidgetManager/);
});

test('Original KeyguardManager uses the shared unsecured-device Trust service',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-trust-service-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(source,'java/com/android/server/HostSchedulingPolicy.java'),path.join(source,'java/maclauncher/android/framework/HostTrustService.java'),path.join(source,'java/maclauncher/android/framework/HostSystemServices.java'),path.join(fixtures,'TrustServiceProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.fixture.TrustServiceProbe',path.resolve(runtime),temporary],env),/PASS original KeyguardManager and complete Trust AIDL/);
});

test('Original system fonts retain complete families, variable axes, fallback and native hyphenation',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-system-fonts-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'SystemFontsProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],process.env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'SystemFontsProbe',path.resolve(runtime),temporary],process.env),/PASS original font families=.*native hyphenation/);
});

test('Service client callbacks retain the original unavailable-count behavior and retire death links',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-service-clients-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'ServiceClientCallbackProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],process.env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'ServiceClientCallbackProbe',path.resolve(runtime),temporary],process.env),/PASS original service callback fallback and callback ownership/);
});

test('Original Android heap reporting follows the actual JVM allowance',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-heap-configuration-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'HeapConfigurationProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],process.env);
  for(const limit of [192,384])assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-Xmx'+limit+'m','-cp',temporary+path.delimiter+cp,'HeapConfigurationProbe',path.resolve(runtime),temporary],process.env),new RegExp('PASS original Android heap reporting matches JVM allowance: '+limit+' MiB'));
});

test('Original PendingIntent owns identity, cancellation and Activity launch results', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-pending-intent-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,...['PendingIntentOwnerProbe','SyntheticResources','PackageManifest'].map(name=>path.join(fixtures,name+'.java')),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],process.env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.PendingIntentOwnerProbe',path.resolve(runtime),temporary],process.env),/PASS original PendingIntent owner, identity, update\/cancel\/one-shot and truthful Activity dispatch/);
});

test('Original platform package has system installation state without promoting ordinary APKs',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-platform-package-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,...['PlatformPackageProbe','SyntheticResources','PackageManifest'].map(name=>path.join(fixtures,name+'.java')),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],process.env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.PlatformPackageProbe',path.resolve(runtime),temporary],process.env),/PASS original platform package system state and ordinary package isolation/);
});

test('Android crypto providers retain complete algorithms and existing JVM provider order', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-crypto-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'CryptoProviderProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],process.env);
  const {cryptoJvmOptions}=require('../src/modules/android/jvm-options'),owned=process.env.ANDROID_NATIVE_SOURCE||source;
  const supplier=path.join(temporary,'supplier'),cache=path.join(temporary,'security');fs.mkdirSync(supplier);fs.mkdirSync(cache);
  const ids=path.join(temporary,'ids');fs.mkdirSync(ids,{mode:0o700});const cryptoEnvironment={...process.env,KL_ANDROID_ID_DIRECTORY:ids};
  fs.copyFileSync(path.join(owned,'resources/java-security.properties'),path.join(supplier,'java-security.properties'));
  const options=cryptoJvmOptions({javaHome:home,runtimeRoot:supplier,cacheRoot:cache});
  assert.equal(options.length,1);
  const file=path.join(cache,'java-security.properties'),modified=fs.statSync(file).mtimeMs;
  assert.deepEqual(cryptoJvmOptions({javaHome:home,runtimeRoot:supplier,cacheRoot:cache}),options);assert.equal(fs.statSync(file).mtimeMs,modified);
  const launch=(arguments_,...mode)=>run(path.join(home,'bin/java'),[...arguments_,'-Xverify:all','-cp',temporary+path.delimiter+cp,'CryptoProviderProbe',path.resolve(runtime),temporary,...mode],cryptoEnvironment);
  const output=launch(options);assert.match(output,/PASS complete Android crypto provider, preserved JVM providers and real cipher\/signature operations/);t.diagnostic(output.trim());
  const configured=path.join(temporary,'jdk');fs.mkdirSync(path.join(configured,'conf/security'),{recursive:true});
  fs.writeFileSync(path.join(configured,'conf/security/java.security'),'security\\.overridePropertiesFile=tr\\u0075e\njdk.security.provider.preferred=Cipher.PBEWithMD5AndDES:SunJCE,\\\n  Mac.PBEWithHmacSHA1:B\\u0043\n');
  assert.match(launch(cryptoJvmOptions({javaHome:configured,runtimeRoot:supplier,cacheRoot:cache}),'SunJCE'),/PASS configured security properties and preference=SunJCE/);
  const explicit=path.join(temporary,'explicit.properties');fs.writeFileSync(explicit,'jdk.security.provider.preferred=Cipher.PBEWithMD5AndDES:SunJCE\njdk.tls.disabledAlgorithms=TLSv1.3\n');
  const explicitArguments=['-Djava.security.properties='+explicit];assert.deepEqual(cryptoJvmOptions({javaHome:home,runtimeRoot:supplier,cacheRoot:cache,javaArguments:explicitArguments}),[]);
  assert.match(launch(explicitArguments,'SunJCE','TLSv1.3'),/PASS configured security properties and preference=SunJCE/);
});

test('JVM crypto preferences retain Properties syntax, explicit policy and optional runtime behavior',t=>{
 const {cryptoJvmOptions,securityProperties}=require('../src/modules/android/jvm-options');
 const values=securityProperties(Buffer.from(' # comment\r\n! comment\nsecurity\\.overridePropertiesFile : tr\\u0075e\njdk.security.provider.preferred = Cipher.PBEWithMD5AndDES:SunJCE,\\\n  Mac.PBEWithHmacSHA256:B\\u0043\nkey\\ with\\ spaces:value\\twith\\ncontrols\\\\end\n','latin1'));
 assert.equal(values.get('security.overridePropertiesFile'),'true');assert.equal(values.get('jdk.security.provider.preferred'),'Cipher.PBEWithMD5AndDES:SunJCE,Mac.PBEWithHmacSHA256:BC');assert.equal(values.get('key with spaces'),'value\twith\ncontrols\\end');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-security-properties-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 assert.deepEqual(cryptoJvmOptions({javaHome:temporary,runtimeRoot:temporary,cacheRoot:temporary}),[]);
 fs.writeFileSync(path.join(temporary,'java-security.properties'),'jdk.security.provider.preferred=Cipher.PBEWithMD5AndDES:BC\n');
 fs.mkdirSync(path.join(temporary,'conf/security'),{recursive:true});fs.writeFileSync(path.join(temporary,'conf/security/java.security'),'security.overridePropertiesFile=false\n');
 assert.deepEqual(cryptoJvmOptions({javaHome:temporary,runtimeRoot:temporary,cacheRoot:temporary}),[]);
 fs.writeFileSync(path.join(temporary,'conf/security/java.security'),'security.overridePropertiesFile=true \n');
 assert.deepEqual(cryptoJvmOptions({javaHome:temporary,runtimeRoot:temporary,cacheRoot:temporary}),[]);
});

test('Original Android Conscrypt retains its full native provider and verifies real TLS peers',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-conscrypt-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),certificate=path.join(temporary,'server.p12');
  run(path.join(home,'bin/keytool'),['-genkeypair','-alias','local','-keyalg','RSA','-keysize','2048','-dname','CN=localhost','-ext','SAN=dns:localhost','-validity','2','-storetype','PKCS12','-keystore',certificate,'-storepass','test-password','-keypass','test-password','-noprompt'],process.env);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'ConscryptTlsProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],process.env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'ConscryptTlsProbe',path.resolve(runtime),temporary,certificate],process.env),/PASS all309 Android Conscrypt natives.*certificate\/hostname rejection/);
});

test('Original Android network security verifies JDK sockets and HTTPS connections',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-jdk-tls-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),certificate=path.join(temporary,'server.p12');
  run(path.join(home,'bin/keytool'),['-genkeypair','-alias','local','-keyalg','RSA','-keysize','2048','-dname','CN=localhost','-ext','SAN=dns:localhost','-validity','2','-storetype','PKCS12','-keystore',certificate,'-storepass','test-password','-keypass','test-password','-noprompt'],process.env);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'ConscryptTlsProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],process.env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'ConscryptTlsProbe',path.resolve(runtime),temporary,certificate,'jdk'],process.env),/PASS original Android network security on JDK SSLSocket\/HttpsURLConnection: trusted peer and certificate\/hostname rejection/);
});

test('AOSP libcore Memory and NIO clients use complete native algorithms and actual JDK storage',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-libcore-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'LibcoreMemoryProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'LibcoreMemoryProbe',path.resolve(runtime),temporary],env),/PASS complete upstream libcore\/ART Memory natives and original NIO clients on JDK owners/);
});

test('Every supplied AIDL contract retains original Stub dispatch independently of host references',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-aidl-catalog-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'ServiceEndpointCatalogProbe.java')],process.env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'ServiceEndpointCatalogProbe',path.resolve(runtime,'android-framework.jar')],process.env),/PASS complete publisher AIDL dispatcher coverage/);
});

test('AOSP fast-data and binary XML retain their codecs with scoped JNI arrays',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-fast-data-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'FastDataProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'FastDataProbe',path.resolve(runtime),temporary],env),/PASS original fast-data and binary XML codecs with scoped JNI arrays/);
});

test('AOSP spans retain native font metrics and original wrapper delegation', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-framework-contracts-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'StartupContractsProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'StartupContractsProbe',path.resolve(runtime),temporary],env),/PASS original font metrics and span delegation/);
});

test('Android legacy background tasks preserve callbacks, cancellation and actual HandlerThread scheduling', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-async-task-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'AsyncTaskProbe.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'AsyncTaskProbe',path.resolve(runtime),temporary],env),/PASS background tasks, cancellation, actual HandlerThread priority and owner shutdown/);
});

test('AOSP ContextImpl retains complete context families and original manager clients', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-context-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'ContextCoreProbe.java'),path.join(fixtures,'PackageManifest.java'),path.join(fixtures,'SyntheticResources.java'),path.join(fixtures,'ProcessHistoryProbe.java'),path.join(fixtures,'../android-native/PreferenceStringSetProbe.java'),path.join(fixtures,'../android-native/ImageProbe.java'),path.join(fixtures,'TrafficStatsProbe.java'),path.join(fixtures,'../android-native/inputmethod/TextInputProbe.java'),...['OptionalHardware','IntentSenderProbe','ShortcutServiceProbe','LayoutInflationProbe','ResourceFixtureData'].map(name=>path.join(fixtures,'../android-native/'+name+'.java'))],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.ContextCoreProbe',path.resolve(runtime),temporary],env),/PASS .* original ContextImpl, package\/window clients, preferences, private storage and dispatcher checks/);
});

test('Original Android account service retains its clients, private storage and lazy lifetime', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-accounts-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,...['AccountServiceProbe','PackageManifest','SyntheticResources'].map(name=>path.join(fixtures,name+'.java'))],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.AccountServiceProbe',path.resolve(runtime),temporary],env),/PASS original AccountManager service, empty real account inventory and private storage/);
});

test('Explicit Google provider compatibility preserves actual signing and account ownership',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME,apk=process.env.KLEPTON_MICROG_APK,certificate=process.env.KLEPTON_MICROG_COMPAT_CERT;
  if(!home||!runtime||!apk||!certificate||process.platform!=='darwin')return t.skip('Requires Java 21, Android runtime and installed microG certificate artifacts');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-provider-identity-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'GoogleProviderTrustProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.framework.GoogleProviderTrustProbe',path.resolve(runtime),temporary,path.resolve(apk),path.resolve(certificate)],env),/PASS explicit provider query identity, unchanged publisher permissions and account storage continuity/);
});

test('AOSP SensorManager uses manual motion and original listener lifetimes',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-manual-motion-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,...['ManualSensorProbe','PackageManifest','SyntheticResources'].map(name=>path.join(fixtures,name+'.java')),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.ManualSensorProbe',path.resolve(runtime),temporary],env),/PASS original sensor factory, manual motion, reentrant listeners, flush and callback retirement/);
});

test('AOSP Activity, PhoneWindow and ViewRoot retain pixels, input and window lifecycle', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-window-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'HostWindowProbe.java'),path.join(fixtures,'PackageManifest.java'),path.join(fixtures,'SyntheticResources.java'),...['LayoutInflationProbe','ResourceFixtureData'].map(name=>path.join(fixtures,'../android-native/'+name+'.java'))],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.HostWindowProbe',path.resolve(runtime),temporary],env),/PASS .* upstream Activity, PhoneWindow, ViewRoot pixels/);
});

test('Mac sleep preserves original Activity lifecycle and focus across both VM bindings',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-host-sleep-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  const identities=path.join(temporary,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,...['HostActivity','HostWindowManager'].map(name=>path.join(source,'java/maclauncher/android/framework',name+'.java')),...['HostSleepProbe','HostWindowProcessProbe','HostWindowProbe','PackageManifest','SyntheticResources'].map(name=>path.join(fixtures,name+'.java')),...['LayoutInflationProbe','ResourceFixtureData'].map(name=>path.join(fixtures,'../android-native/'+name+'.java'))],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-Dandroid.fixture.input=maclauncher.android.HostSleepProbe','-cp',temporary+path.delimiter+cp,'maclauncher.android.HostWindowProcessProbe',path.resolve(runtime),temporary],env),/PASS shared host sleep, original pause\/resume, preserved focus/);
});

test('Committed native resize uses original component callbacks and Activity relaunch policy',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-configuration-change-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  const identities=path.join(temporary,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
  const changes=env.ANDROID_CONFIGURATION_SOURCE==='0'?[]:['HostApplication','HostActivity','FrameworkResources','HostSurface','HostSurfaceControl'].map(name=>path.join(source,'java/maclauncher/android/framework',name+'.java'));
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,...changes,...['ConfigurationChangeProbe','HostWindowProcessProbe','HostWindowProbe','PackageManifest','SyntheticResources'].map(name=>path.join(fixtures,name+'.java')),...['LayoutInflationProbe','ResourceFixtureData'].map(name=>path.join(fixtures,'../android-native/'+name+'.java'))],env);
  if(changes.length){
    const asm=JSON.parse(fs.readFileSync(path.join(source,'asm-binary.json'))).files.map(file=>path.join(source,'tools',file.path)).join(path.delimiter),bindingCp=[temporary,cp,asm].join(path.delimiter);
    run(path.join(home,'bin/javac'),['--release','21','-cp',bindingCp,'-d',temporary,path.join(source,'framework/NativeBindings.java'),path.join(fixtures,'../android-framework-policy/FrameworkNativeOverlay.java')],env);
    run(path.join(home,'bin/java'),['-cp',bindingCp,'FrameworkNativeOverlay',path.resolve(runtime,'android-framework.jar'),temporary,'android/view/SurfaceControl'],env);
  }
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-Dandroid.fixture.input=maclauncher.android.ConfigurationChangeProbe','-cp',temporary+path.delimiter+cp,'maclauncher.android.HostWindowProcessProbe',path.resolve(runtime),temporary],env),/PASS original configuration callbacks, coalesced resize, manifest policy and Activity relaunch ownership/);
});

test('Android transaction latch is independent of hidden output and native presentation backpressure',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-canvas-latch-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  const identities=path.join(temporary,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
  const changes=['bridge/CanvasFrameSource','bridge/CanvasOverlay','framework/HostSurfaceControl'].map(name=>path.join(source,'java/maclauncher/android',name+'.java'));
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,...changes,...['CanvasLatchProbe','HostWindowProbe','PackageManifest','SyntheticResources'].map(name=>path.join(fixtures,name+'.java')),...['LayoutInflationProbe','ResourceFixtureData'].map(name=>path.join(fixtures,'../android-native/'+name+'.java'))],env);
  const asm=JSON.parse(fs.readFileSync(path.join(source,'asm-binary.json'))).files.map(file=>path.join(source,'tools',file.path)).join(path.delimiter),bindingCp=[temporary,cp,asm].join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',bindingCp,'-d',temporary,path.join(source,'framework/NativeBindings.java'),path.join(fixtures,'../android-framework-policy/FrameworkNativeOverlay.java')],env);
  run(path.join(home,'bin/java'),['-cp',bindingCp,'FrameworkNativeOverlay',path.resolve(runtime,'android-framework.jar'),temporary,'android/view/SurfaceControl'],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-Dandroid.fixture.input=maclauncher.android.CanvasLatchProbe','-cp',temporary+path.delimiter+cp,'maclauncher.android.HostWindowProbe',path.resolve(runtime),temporary],env),/PASS original transaction latch, coalesced identity, backend backpressure and independent physical display/);
});

test('Android graphics capability queries preserve actual EGL configuration behavior', async t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-graphics-capability-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const identity=await require('../src/modules/android/process-channel').processNamespace(temporary,1);
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env,...identity.environment};
  const overlay=[];
  if(env.KL_MVK_DYLIB&&env.VULKAN_HEADERS&&env.KLEPTON_SOURCE){
    const {prepareVulkanSource}=await import('../src/modules/android/native/vulkan-sources.mjs');
    const prepared=prepareVulkanSource(env.KLEPTON_SOURCE,temporary),library=path.join(temporary,'capabilities.dylib');
    run('clang',['-arch','arm64','-mmacosx-version-min=13.0','-O1','-dynamiclib','-I'+source,'-I'+env.VULKAN_HEADERS,
      '-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),
      ...['','jni','libc','gfx','xr','media','guest','diag'].map(name=>'-I'+path.join(env.KLEPTON_SOURCE,'runtime',name)),
      prepared,path.join(source,'eglbridge.c'),path.join(fixtures,'vulkan-capabilities-probe.c'),
      path.resolve(runtime,'native/libklepton-jvm.dylib'),'-Wl,-rpath,'+path.resolve(runtime,'native'),'-lz','-lc++','-o',library],env);
    overlay.push(library);
  }
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(source,'java/maclauncher/android/bridge/Graphics.java'),path.join(source,'java/maclauncher/android/framework/HostActivityManager.java'),path.join(source,'java/maclauncher/android/framework/HostPackages.java'),path.join(fixtures,'GraphicsCapabilityProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],env);
  const evidence=run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'android.app.GraphicsCapabilityProbe',path.resolve(runtime),temporary,...overlay],env);
  for(const line of evidence.split('\n').filter(value=>value.startsWith('Selected Vulkan')))t.diagnostic(line);
  assert.match(evidence,/PASS queried EGL capability and AOSP configuration/);
});

test('AOSP messages preserve queue ordering, barriers, native FD readiness and retirement', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-messages-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  const identities=path.join(temporary,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
  const inputAdapters=process.env.ANDROID_INPUT_QUEUE_INTEGRATED==='1'?[]:[path.join(source,'java/maclauncher/android/framework/HostInputQueue.java')];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(source,'java/maclauncher/android/framework/HostLooper.java'),path.join(source,'java/maclauncher/android/framework/HostDisplayEvents.java'),...inputAdapters,path.join(fixtures,'NativeMessageQueueProbe.java')],env);
  const helper=path.join(temporary,'pipe.dylib');
  run('clang',['-dynamiclib','-Wall','-Wextra','-Werror','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(fixtures,'message-queue-jni.c'),path.resolve(runtime,'native/libklepton-jvm.dylib'),'-Wl,-rpath,'+path.resolve(runtime,'native'),'-o',helper],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'NativeMessageQueueProbe',path.resolve(runtime),temporary,helper],env),/PASS raw AOSP messages/);
});

test('AOSP process, clocks, StrictMode and files use actual host OS ownership', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-os-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'NativeOsProbe.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'NativeOsProbe',path.resolve(runtime),temporary],env),/PASS raw Process\/SystemClock\/StrictMode/);
});

test('Original APK verification, mapped buffers and VM queries use actual platform owners',t=>{
 const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-mapped-files-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'../android-window-session/RuntimeFixture.java'),path.join(fixtures,'IncrementalFilesystemProbe.java')],env);
 const args=['-Xverify:all','-cp',temporary+path.delimiter+cp,'IncrementalFilesystemProbe',path.resolve(runtime),temporary];
 if(process.env.KLEPTON_SIGNED_APK)args.push(path.resolve(process.env.KLEPTON_SIGNED_APK));
 assert.match(run(path.join(home,'bin/java'),args,env),/PASS original incremental filesystem observations and APK signature verification fallbacks/);
});



test('AOSP SQLite uses original transaction, cursor and connection state with native private storage', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-sqlite-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'NativeDatabaseProbe.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'NativeDatabaseProbe',path.resolve(runtime),temporary],env),/PASS raw SQLite transaction/);
});


for(const [probe,description,success] of [
 ['JobSchedulerProbe','AOSP jobs retain original clients, service dispatch and completion',/PASS upstream job service/],
 ['PackageServiceProbe','AOSP package client uses inspected local metadata and native resources',/PASS full AOSP package client/],
 ['FrameworkValuesProbe','AOSP value families retain complete state and actual host snapshots',/PASS complete AOSP value/],
 ['AppOpsServiceProbe','AOSP app operations retain original service state and callback retirement',/PASS raw AppOps client/]
])test(description,t=>{
 const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-framework-values-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,probe+'.java'),path.join(fixtures,'PackageManifest.java'),path.resolve('tests/fixtures/android-platform-service/MediaServicesFixture.java'),path.resolve('tests/fixtures/android-platform-service/NotificationMigrationProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],env);
 assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,probe==='JobSchedulerProbe'?'maclauncher.android.fixture.'+probe:probe,path.resolve(runtime),temporary],env),success);
});

test('AOSP component XML metadata and preference defaults use original Context storage', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-framework-contracts-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'MetadataPreferencesProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java'),path.join(fixtures,'../android-native/CompiledXmlFixtures.java'),path.join(fixtures,'../android-native/ResourceFixtureData.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'android.content.res.MetadataPreferencesProbe',path.resolve(runtime),temporary],env),/PASS metadata XML ownership/);
});

test('AOSP URI builders, parcels and adapter observers preserve value semantics', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-framework-contracts-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'UriAdapterProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'UriAdapterProbe',path.resolve(runtime),temporary],env),/PASS upstream URI builders, encoded values, Parcelable identities and adapter observers/);
});

test('Android Parcel descriptors own real files, pipes and independent native duplicates', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-parcel-fd-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|KLEPTON_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'ParcelFileDescriptorProbe.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'ParcelFileDescriptorProbe',path.resolve(runtime),temporary],env),/PASS real descriptors, shared offsets, streams, pipes and Parcel ownership/);
});

test('AOSP StrictJarFile retains manifest verification and descriptor-backed ZIP streams',t=>{
 const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-strict-jar-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'StrictJarFileProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],env);
 assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'StrictJarFileProbe',path.resolve(runtime),temporary],env),/PASS original StrictJarFile/);
});

test('AOSP portability normalization retains real behavior and untouched native methods', t => {
  const home=javaHome();if(!home)return t.skip('Java 21 development tools are not installed');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-framework-portability-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const asm=JSON.parse(fs.readFileSync(path.join(source,'asm-binary.json'),'utf8')).files.map(file=>path.join(source,'tools',file.path)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KLEPTON_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',asm,'-d',temporary,...javaFiles(path.join(source,'framework')),...javaFiles(path.join(source,'portability')),path.join(fixtures,'FrameworkPortabilityProbe.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+asm,'FrameworkPortabilityProbe'],env),/PASS portable AOSP calls, unchanged native declarations and JVM error semantics/);
});

test('AOSP content resolver retains upstream observer and Binder behavior', async t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-content-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KLEPTON_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  Object.assign(env,(await require('../src/modules/android/process-channel').processNamespace(temporary,1)).environment);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'NativeContentServiceProbe.java'),path.join(source,'java/maclauncher/android/LocalProviders.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'NativeContentServiceProbe',path.resolve(runtime),temporary],env),/PASS .* raw AOSP content observers, resolver service lookup and Binder transactions/);
});

test('PCM source queues retain independent clocks and cancellation', t => {
  if(process.platform!=='darwin')return t.skip('Requires macOS native tools');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-pcm-sources-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const native=path.resolve('src/modules/android/native'),probe=path.join(temporary,'probe');
  run('clang',['-std=c11','-O1','-I'+native,path.join(native,'audio-pcm.c'),path.resolve('tests/fixtures/android-audio/PCMSourceProbe.c'),'-o',probe]);
  assert.match(run(probe,[]),/PASS independent PCM queues/);
});

test('AOSP AudioTrack streams PCM through the native audio owner', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-audio-track-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.resolve('tests/fixtures/android-platform-service/MediaServicesFixture.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java'),path.join(fixtures,'NativeAudioTrackProbe.java')],env);
  const observer=path.join(temporary,'audio-output-observer.dylib');
  run('clang',['-dynamiclib','-Wall','-Wextra','-Werror','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(fixtures,'audio-output-observer.c'),'-framework','AudioToolbox','-framework','CoreAudio','-o',observer],env);
  env.DYLD_INSERT_LIBRARIES=observer;
  const evidence=process.env.ANDROID_AUDIO_EVIDENCE;
  const output=run(path.join(home,'bin/java'),['-Xverify:all','-Xcheck:jni','-cp',temporary+path.delimiter+cp,'NativeAudioTrackProbe',path.resolve(runtime),temporary,observer],env,result=>{
    if(evidence){fs.mkdirSync(evidence,{recursive:true,mode:0o700});fs.writeFileSync(path.join(evidence,'stdout.log'),result.stdout||'');fs.writeFileSync(path.join(evidence,'stderr.log'),result.stderr||'');fs.writeFileSync(path.join(evidence,'exit.json'),JSON.stringify({status:result.status,signal:result.signal,error:result.error?.message})+'\n');}
  });
  assert.match(output,/PASS original AudioTrack PCM/);assert.match(output,/AUDIO_OUTPUT/);console.log(output.trim());
});

test('AOSP surface clients retain actual native buffers and display queue ownership', t => {
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!runtime||process.platform!=='darwin')return t.skip('KLEPTON_NATIVE_RUNTIME on macOS is required');
  const home=javaHome();if(!home)return t.skip('Java 21 is required');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-surface-framework-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  const helper=path.join(temporary,'surface-scene.dylib');
  run('clang',['-dynamiclib','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(fixtures,'surface-scene-owner.c'),'-framework','CoreFoundation','-o',helper],env);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'NativeSurfaceFrameworkProbe.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'NativeSurfaceFrameworkProbe',path.resolve(runtime),temporary,helper],env),/PASS raw Surface\/SurfaceControl\/BLAST/);
});

test('AOSP graphics use the complete published native family and original drawable state', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-graphics-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const framework=path.resolve(runtime,'android-framework.jar');
  const env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',framework,'-d',temporary,path.join(fixtures,'NativeGraphicsProbe.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+framework,'NativeGraphicsProbe',path.resolve(runtime)],env),/PASS original AOSP graphics/);
});

test('AOSP resources use original APK assets, native styles and compiled XML', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-resources-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'NativeResourcesProbe.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'NativeResourcesProbe',path.resolve(runtime),temporary],env),/PASS original AOSP resources/);
});

test('Original PlayCore resolves installed APK asset packs to real bundle bytes',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME,launch=process.env.KLEPTON_ASSET_PACK_LAUNCH;
  if(!home||process.platform!=='darwin'||!runtime||!launch)return t.skip('Requires Java 21, Android runtime and a prepared asset-pack launch configuration');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-installed-pack-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const config=JSON.parse(fs.readFileSync(launch,'utf8'));
  const cp=[...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)),config.convertedJar].join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'InstalledAssetPackProbe.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Djava.awt.headless=true','-Xverify:all','-cp',temporary+path.delimiter+cp,'InstalledAssetPackProbe',path.resolve(runtime),path.resolve(launch),temporary],env),/PASS original PlayCore locates real installed UnityDataAssetPack bundle/);
});

test('AOSP Environment composes scoped paths and reports the actual private volume', t => {
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-filesystem-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
  for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixtures,'NativeFilesystemProbe.java')],env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'NativeFilesystemProbe',path.resolve(runtime),temporary],env),/PASS raw AOSP filesystem paths/);
});

for(const [probe,main,dependencies] of [
 ['SourceApksProbe','maclauncher.android.SourceApksProbe',['SyntheticResources','NativeResourceSupport']],
 ['ConditionProbe','ConditionProbe',['../android-window-session/RuntimeFixture']]
])test('Original Android resource and clock contracts: '+probe,t=>{
 const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-core-contract-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,...[probe,...dependencies].map(name=>path.join(fixtures,name+'.java'))],env);
 assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,main,temporary,path.resolve(runtime)],env),/PASS /);
});


test('Shared account selection preserves original callbacks and unrelated authenticators',t=>{
  const home=javaHome(),runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(!home||process.platform!=='darwin'||!runtime)return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-account-selection-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(source,'java/maclauncher/android/framework/HostAccountAccess.java'),path.join(fixtures,'AccountSelectionProbe.java'),path.join(fixtures,'../android-window-session/RuntimeFixture.java')],process.env);
  assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'maclauncher.android.framework.AccountSelectionProbe',path.resolve(runtime),temporary],process.env),/PASS account selection: anonymous, selected, original callbacks and unrelated authenticators/);
});
