const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');

test('WebView callback URLs remain nonnull across actual provider data, reload and redirect operations',{timeout:30000},t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,jdk=process.env.JAVA_HOME;
 if(!runtime||!jdk)return t.skip('Requires Java21 and the Android runtime archives');
 const source=process.env.KLEPTON_ANDROID_SOURCE||path.resolve('src/external/maclauncher-android');
 const retained=process.env.KLEPTON_WEBKIT_CALLBACK_OUTPUT;
 const output=retained?path.resolve(retained):fs.mkdtempSync(path.join(os.tmpdir(),'android-webkit-callback-'));
 if(!retained)t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const classes=path.join(output,'classes'),probes=path.join(output,'probe-classes'),shim=path.join(output,'shim-classes');
 for(const directory of [classes,probes,shim])fs.mkdirSync(directory,{recursive:true});
 const cp=[classes,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
 const fixture=path.resolve('tests/fixtures/android-webkit-callback');
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:1<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 // Production classes are compiled against the real native boundary. Only
 // this separate CPU control substitutes the transport at execution time.
 run(path.join(jdk,'bin/javac'),['--release','21','-cp',cp,'-d',classes,path.join(source,'src/modules/android/native/java/maclauncher/android/web/WebKitView.java')]);
 run(path.join(jdk,'bin/javac'),['--release','21','-d',shim,path.join(fixture,'WebKitNative.java')]);
 run(path.join(jdk,'bin/javac'),['--release','21','-cp',[shim,cp].join(path.delimiter),'-d',probes,path.join(fixture,'WebKitCallbackProbe.java')]);
 const result=run(path.join(jdk,'bin/java'),['-Xverify:all','-cp',[shim,probes,cp].join(path.delimiter),'WebKitCallbackProbe']);
 assert.match(result,/PASS nonnull WebView errors/);t.diagnostic(result.trim());
});
