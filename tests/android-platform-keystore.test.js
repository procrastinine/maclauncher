const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawn, execFileSync } = require('node:child_process'), { once } = require('node:events');
const { acquire } = require('../src/modules/android/platform-services/client');
const { paths } = require('../src/modules/android/platform-services/paths');
const { send, processIdentity, prepareProcessQuerySpawn } = require('../src/modules/android/process-channel');
const { prepareSandbox } = require('../src/modules/android/sandbox');
const { frameworkJvmOptions } = require('../src/modules/android/jvm-options');

test('Listener session capabilities retire with their enrolled process, including already-connected clients', { timeout: 30000 }, async t => {
  const runtime=process.env.ANDROID_PLATFORM_RUNTIME,home=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires the platform-service runtime and Java21');
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'android-listener-owner-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const cp=[root,runtime+'/android-host.jar',runtime+'/android-framework.jar'].join(path.delimiter);
  execFileSync(home+'/bin/javac',['--release','21','-cp',cp,'-d',root,
    'tests/fixtures/android-platform-service/PlatformListenerProbe.java','tests/fixtures/android-window-session/RuntimeFixture.java',
    'tests/fixtures/android-framework-services/SyntheticResources.java']);
  const output=execFileSync(home+'/bin/java',[...frameworkJvmOptions,'-Xverify:all','-cp',cp,
    'maclauncher.android.fixture.PlatformListenerProbe',path.resolve(runtime),root],{encoding:'utf8',timeout:20000});
  assert.match(output,/PASS platform listener/);
});

test('The isolated original profile KeyStore preserves GCM operations across owner restarts and admits only enrolled app UIDs', { timeout: 100000 }, async t => {
  const runtimeRoot = process.env.ANDROID_PLATFORM_RUNTIME, home = process.env.JAVA_HOME;
  if (process.platform !== 'darwin' || !runtimeRoot || !home) return t.skip('Requires the original platform-service runtime and Java21');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'android-keystore-owner-')));
  const storage = await paths(root), children = new Set(); let lease;
  t.after(async () => {
    lease?.close(); for (const child of children) child.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 3000));
    await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage.runRoot, { recursive: true, force: true });
  });
  const options = { userDataDir: root, runtimeRoot: path.resolve(runtimeRoot), javaPath: path.join(home, 'bin/java'), moduleRoot: path.resolve('src/modules/android') };
  const identityVersion=JSON.parse(await fs.readFile(path.join(runtimeRoot,'runtime.json'),'utf8')).profile.processIdentityVersion||0;
  const classes = path.join(root, 'classes'); await fs.mkdir(classes);
  execFileSync(path.join(home, 'bin/javac'), ['--release', '21', '-cp', [runtimeRoot+'/android-host.jar', runtimeRoot+'/android-framework.jar'].join(path.delimiter),
    '-d', classes, path.join(__dirname, 'fixtures/android-platform-service/ProfileKeyStoreProbe.java')]);
  // The test fixture is copied into its own runtime view; no shared payload is mutated.
  const fixtureJar = path.join(root, 'fixture.jar');
  execFileSync(path.join(home, 'bin/jar'), ['cf', fixtureJar, '-C', classes, '.']);
  const sandboxRuntime = path.join(root, 'client-runtime');
  await fs.cp(runtimeRoot, sandboxRuntime, { recursive: true, dereference: true, mode: require('node:fs').constants.COPYFILE_FICLONE,
    filter: file => !['build','source','build-source.json','build-receipt.json'].includes(path.relative(runtimeRoot,file).split(path.sep)[0]) });
  await fs.copyFile(fixtureJar, path.join(sandboxRuntime, 'fixture.jar'));
  async function client(mode, uid) {
    const app = path.join(root, 'apps', 'uid-'+uid), data = path.join(app, 'data');
    const config = { runtimeRoot: sandboxRuntime, filesRoot: path.join(data, 'files'), cacheRoot: path.join(data, 'cache') };
    await fs.mkdir(config.filesRoot, { recursive: true }); await fs.mkdir(config.cacheRoot, { recursive: true });
    const configFile = path.join(app, 'launch.json'); await fs.writeFile(configFile, '{}');
    const isolated = await prepareSandbox({ javaPath: options.javaPath, config, configFile, dataRoot: data, blockNetwork: true,
      userDataDir:root,processIdentityVersion:identityVersion,
      localSockets: { connect: [lease.socketPath] } });
    const name = 'example.keys.u'+uid;
    const query=prepareProcessQuerySpawn({cwd:config.filesRoot,env:isolated.environment,stdio:['ignore','pipe','pipe','ignore','ignore','pipe']},path.join(sandboxRuntime,'native/android-supervisor-send'));
    const child = spawn(isolated.command, [...isolated.prefix, ...isolated.javaArguments, ...frameworkJvmOptions,
      '-cp', ['fixture.jar','android-host.jar','android-framework.jar'].map(file=>path.join(sandboxRuntime,file)).join(path.delimiter),
      'maclauncher.android.ProfileKeyStoreProbe', sandboxRuntime, data, name, mode, storage.metadata, storage.controllerSocket],
    query.options);
    query.attach(child);
    children.add(child); child.once('exit',()=>children.delete(child));
    let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);
    const result=once(child,'exit');
    try {
      await once(child,'spawn');
      const peer={packageName:name,processName:name,...await processIdentity(child,{version:identityVersion}),uid,hostUid:process.getuid()};
      await lease.enroll(peer);
      await send(child.stdio[5],{schemaVersion:2,self:peer,platform:{identity:lease.identity,socketPath:lease.socketPath}});
      const [code,signal]=await result;
      assert.equal(code,0,signal+'\n'+stdout+'\n'+stderr);assert.match(stdout,/PASS profile KeyStore/);
      await lease.retire(peer);
    } finally { if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL'); }
  }
  lease=await acquire(options);const first=lease.identity.pid;
  await client('create',10001);await Promise.all([client('read',10001),client('deny',10002)]);
  lease.close();lease=null;
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){try{await fs.access(storage.metadata);}catch(error){if(error.code==='ENOENT')break;throw error;}await new Promise(resolve=>setTimeout(resolve,25));}
  await assert.rejects(fs.access(storage.metadata),{code:'ENOENT'});
  lease=await acquire(options);assert.notEqual(lease.identity.pid,first);
  await client('read',10001);
});
