const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('Android per-game keyboard touch settings use a matching host and normalized positions',()=>{
 const host=require('../src/modules/android/host'),manifest=require('../src/modules/android/manifest.json'),settings=manifest.runtime.entries.klepton.settings;
 const prepared={metadata:{packageName:'example.game',launchers:[{activity:'example.game.Activity'}]}};
 const make=(values={},profile={keyboardTouchVersion:1},service=false)=>host.launchConfig({},prepared,{root:'/runtime',profile},values,{},service);
 assert.equal(settings.defaults.touchJoystick,'wasd');assert.equal(settings.fields.find(f=>f.key==='touchJoystick').gameOnly,true);
 assert.equal(make().touchJoystick,'wasd');assert.deepEqual([make().touchJoystickX,make().touchJoystickY,make().touchJoystickRadius],[1800,7500,1200]);
 assert.equal(make({touchJoystick:'off'}).touchJoystick,'off','An explicit per-game Off selection is retained');
 assert.deepEqual([make({touchJoystick:'wasd',touchJoystickX:22.35,touchJoystickY:80,touchJoystickRadius:10}).touchJoystick,make({touchJoystickX:22.35}).touchJoystickX],['wasd',2235]);
 assert.equal(Object.hasOwn(make({touchJoystick:'wasd'},{}),'touchJoystick'),false,'Existing payload contracts receive unchanged launch data');
 assert.equal(Object.hasOwn(make({touchJoystick:'wasd'},{keyboardTouchVersion:1},true),'touchJoystick'),false,'Service processes have no game touch mapping');
 for(const value of [-1,101,NaN,'20'])assert.throws(()=>make({touchJoystickX:value}),/percentage/);
 assert.throws(()=>make({touchJoystickRadius:0}),/percentage/);
});
test('Keyboard and mouse share original multi-pointer touch dispatch and lifecycle',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires actual Android native runtime and JDK21');
 const source=path.resolve('src/modules/android/native'),fixture=path.resolve('tests/fixtures/android-framework-services'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-keyboard-touch-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const asm=JSON.parse(fs.readFileSync(path.join(source,'asm-binary.json'))).files.map(f=>path.join(source,'tools',f.path));
 const framework=path.resolve(runtime,'android-framework.jar'),host=path.resolve(runtime,'android-host.jar'),cp=[temp,...asm,host,framework].join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 const identities=path.join(temp,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
 function run(name,args){const result=spawnSync(path.join(home,'bin',name),args,{encoding:'utf8',env,timeout:30000,maxBuffer:4<<20});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
 run('javac',['--release','21','-cp',cp,'-d',temp,path.join(source,'java/maclauncher/android/ApplicationSettings.java'),...['HostInput','HostScrollInput','HostWindowManager','HostTextInput','HostSensors'].map(n=>path.join(source,'java/maclauncher/android/framework',n+'.java')),...['KeyboardTouchProbe','HostWindowProbe','PackageManifest','SyntheticResources'].map(n=>path.join(fixture,n+'.java')),...['LayoutInflationProbe','ResourceFixtureData'].map(n=>path.join(fixture,'../android-native',n+'.java'))]);
 assert.match(run('java',['-Xverify:all','-Dandroid.fixture.input=maclauncher.android.KeyboardTouchProbe','-cp',cp,'maclauncher.android.HostWindowProbe',path.resolve(runtime),temp]),/PASS original multi-pointer ViewRoot input/);
});
