const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {spawnSync,frameworkArguments} = require('./helpers/android-java');

test('WebKit document synchronization retains original Android Editable behavior',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires an Android runtime and Java 21 on macOS');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-webkit-editor-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const classes=path.join(root,'classes');fs.mkdirSync(classes);
  const ids=path.join(root,'ids');fs.mkdirSync(ids,{mode:0o700});
  const cp=[classes,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  const fixture=path.join(__dirname,'fixtures/android-framework-services');
  const compile=spawnSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',classes,path.join(fixture,'WebKitEditorProbe.java'),path.join(fixture,'PackageManifest.java'),path.join(fixture,'../android-window-session/RuntimeFixture.java')],{encoding:'utf8'});
  assert.equal(compile.status,0,compile.stdout+compile.stderr);
  const result=spawnSync(path.join(home,'bin/java'),['-Xverify:all','-cp',cp,'maclauncher.android.web.WebKitEditorProbe',path.resolve(runtime),path.join(root,'data')],{env:{...process.env,KL_ANDROID_ID_DIRECTORY:fs.realpathSync(ids)},encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS original WebKit Editable: single commit, UTF-16, composition, surrounding text, code-point deletion, batching and stale callback ownership/);
});

test('WebKit provider identity uses the configured JVM or ART runtime archive',async t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires a built Android runtime and Java 21 on macOS');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-webkit-provider-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const classes=path.join(root,'classes');fs.mkdirSync(classes);
  const cp=[classes,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  const fixture=path.join(__dirname,'fixtures/android-framework-services');
  const source=path.resolve(__dirname,'../src/modules/android/native/java');
  const compile=spawnSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',classes,path.join(source,'maclauncher/android/web/WebKitFactory.java'),path.join(fixture,'WebKitProviderProbe.java'),path.join(fixture,'../android-window-session/RuntimeFixture.java')],{encoding:'utf8'});
  assert.equal(compile.status,0,compile.stdout+compile.stderr);
  const {guestHooksArchive,environment}=await import('../src/modules/android/art/layout.mjs');
  assert.equal(environment({bootClasspath:[]}).CLASSPATH,guestHooksArchive);
  const ids=path.join(root,'ids');fs.mkdirSync(ids,{mode:0o700});
  for(const [name,archive] of [['jvm',path.resolve(runtime,'android-host.jar')],['art',guestHooksArchive]]){
    const result=spawnSync(path.join(home,'bin/java'),['-Xverify:all','-cp',cp,'maclauncher.android.web.WebKitProviderProbe',path.resolve(runtime),path.join(root,name),archive],{env:{...process.env,KL_ANDROID_ID_DIRECTORY:ids},encoding:'utf8',timeout:20000});
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.match(result.stdout,/PASS explicit WebKit provider origin, original package discovery/);
  }
});

test('original Android WebView uses actual WebKit pixels, input, JavaScript and per-game networking', async t => {
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires a built Android runtime and Java 21 on macOS');
  const {processIdentityVersion}=JSON.parse(fs.readFileSync(path.join(runtime,'runtime.json'))).profile;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-webkit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const inputs=path.join(root,'inputs'),classes=path.join(inputs,'classes');fs.mkdirSync(classes,{recursive:true});
  const graphics=process.env.ANDROID_WEBKIT_GRAPHICS?path.join(inputs,'libklepton-graphics.dylib'):path.resolve(runtime,'native/libklepton-graphics.dylib');
  if(process.env.ANDROID_WEBKIT_GRAPHICS)fs.copyFileSync(process.env.ANDROID_WEBKIT_GRAPHICS,graphics);
  const fixture=path.join(__dirname,'fixtures/android-framework-services'),cp=[classes,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  const env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  const compile=spawnSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',classes,...['WebKitProbe','SyntheticResources','PackageManifest'].map(name=>path.join(fixture,name+'.java')),path.join(fixture,'../android-window-session/RuntimeFixture.java')],{env,encoding:'utf8'});assert.equal(compile.status,0,compile.stdout+compile.stderr);
  const sdl=path.resolve(process.env.KLEPTON_SDL_FRAMEWORK||path.join(runtime,'native/SDL3.framework'));assert.ok(fs.existsSync(path.join(sdl,'Headers/SDL.h')),'Set KLEPTON_SDL_FRAMEWORK to the original SDL3 framework headers');
  const helper=path.join(inputs,'webkit-pump.dylib');const native=spawnSync('clang++',['-dynamiclib','-std=c++20','-fobjc-arc','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(fixture,'webkit-pump.mm'),'-F'+path.dirname(sdl),'-framework','SDL3','-Wl,-rpath,'+path.resolve(runtime,'native'),'-framework','AppKit','-o',helper],{env,encoding:'utf8'});assert.equal(native.status,0,native.stdout+native.stderr);
  let requests=0;const server=http.createServer((request,response)=>{requests++;response.setHeader('Access-Control-Allow-Origin','*');if(request.url==='/probe/redirect'){response.writeHead(302,{Location:'/probe/redirected'});response.end();}else response.end('actual local server');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const policy=process.env.ANDROID_WEBKIT_POLICY==='1',frames=process.env.ANDROID_WEBKIT_FRAMES==='1',layout=process.env.ANDROID_WEBKIT_LAYOUT==='1',keyboard=process.env.ANDROID_WEBKIT_KEYBOARD==='1',pixels=process.env.ANDROID_WEBKIT_PIXELS==='1',cookies=process.env.ANDROID_WEBKIT_COOKIES==='1',navigation=process.env.ANDROID_WEBKIT_NAVIGATION==='1';
  const modes=process.env.ANDROID_WEBKIT_NETWORK==='isolated'?[false]:process.env.ANDROID_WEBKIT_NETWORK==='allowed'?[true]:[true,false];
  for(const allowed of modes)await t.test(allowed?'network allowed':'network isolated',async()=>{
    const data=path.join(root,String(allowed)),filesRoot=path.join(data,'files'),cacheRoot=path.join(data,'cache'),configFile=path.join(data,'launch.json');fs.mkdirSync(filesRoot,{recursive:true});fs.mkdirSync(cacheRoot,{recursive:true});fs.writeFileSync(configFile,'{}');
    const manifests=path.join(data,'tests/fixtures/android-framework-services/manifests');fs.mkdirSync(manifests,{recursive:true});fs.copyFileSync(path.join(fixture,'manifests/webkit.xml.bin'),path.join(manifests,'webkit.xml.bin'));
    const isolated=await require('../src/modules/android/sandbox').prepareSandbox({javaPath:path.join(home,'bin/java'),userDataDir:root,processIdentityVersion,config:{runtimeRoot:path.resolve(runtime),filesRoot,cacheRoot,resourcesRoot:inputs,webLinksAllowed:0,networkAllowed:allowed?1:0},configFile,dataRoot:data,blockNetwork:!allowed});
    const retina=process.env.ANDROID_WEBKIT_RETINA==='1';
    const before=requests,args=frameworkArguments(path.join(home,'bin/java'),[...isolated.javaArguments,'-XstartOnFirstThread','-Xverify:all','-cp',cp,'maclauncher.android.WebKitProbe',path.resolve(runtime),data,helper,graphics,String(allowed),`http://127.0.0.1:${server.address().port}/probe`,...(policy?['policy']:frames?['frames']:layout?['layout']:pixels?['pixels']:navigation?['navigation']:cookies?['cookies']:keyboard?['keyboard']:retina?['retina']:[])]);
    const result=await new Promise((resolve,reject)=>{const child=spawn(isolated.command,[...isolated.prefix,...args],{cwd:data,env:isolated.environment,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);const timer=setTimeout(()=>child.kill('SIGKILL'),45000);child.on('error',reject);child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,output});});});
    assert.equal(result.signal,null,result.output);assert.equal(result.code,0,result.output);assert.match(result.output,policy?/PASS original Android navigation origin/:frames?/PASS original Android subframe requests/:layout?/PASS WebKit document extent and independent text zoom/:pixels?/PASS WebKit reusable pixel transfer/:navigation?/PASS original Android same-document fragment callbacks/:cookies?/PASS WebKit cookie visibility/:keyboard?/PASS keyboard: single commit, Unicode, IME composition/:retina?/PASS Retina WebKit: native point layout, exact Android pixels and scaled input/:/PASS original WebView, actual WebKit pixels, trusted click/);
    if(frames||!policy&&!layout&&!retina&&!keyboard&&!cookies&&!navigation&&!pixels)assert.equal(requests>before,allowed,'actual local server observes only the network-allowed browser request');
  });
});
