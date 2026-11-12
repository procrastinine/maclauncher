const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn, spawnSync } = require("node:child_process"), { once } = require("node:events");
const Sessions = require("../src/modules/video/session-directory"), Config = require("../src/modules/video/configuration");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-session-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, "tmpdir", () => root);
  return root;
}
async function child(t, args) {
  const value = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: {...process.env,TMPDIR:os.tmpdir()} });
  t.after(async () => { if (value.exitCode == null && value.signalCode == null) { value.kill("SIGKILL");await once(value, "close"); } });
  await once(value, "spawn");return value;
}
function old(directory) { const time = new Date(Date.now() - 120000);fs.utimesSync(directory, time, time); }
test("session cleanup is idempotent, retries a failed removal and never follows resource links", t => {
  const root = fixture(t), session = Sessions.create(), original = path.join(root, "original");
  fs.mkdirSync(original);fs.writeFileSync(path.join(original, "font"), "preserved");fs.symlinkSync(original, path.join(session.directory, "resource"));
  const remove = fs.rmSync, mocked = t.mock.method(fs, "rmSync", () => {throw Error("busy");});
  assert.doesNotThrow(session.cleanup);assert.ok(fs.existsSync(session.directory));mocked.mock.restore();
  session.cleanup();session.cleanup();assert.equal(fs.existsSync(session.directory), false);assert.equal(fs.readFileSync(path.join(original, "font"), "utf8"), "preserved");
});
test("configuration failure after allocation removes the session and preserves the original error", t => {
  const root = fixture(t), mkdir = fs.mkdirSync, reason = Error("font setup failed");
  t.mock.method(fs, "mkdirSync", (file, ...args) => {if (path.basename(file) === "fonts") throw reason;return mkdir(file, ...args);});
  assert.throws(() => Config.prepare({userDataDir: root, runtimeSettings: {uosc: false, timelinePreviews: false}}), error => error === reason);
  assert.deepEqual(fs.readdirSync(root), []);
});
test("a preparation whose caller forgot cleanup is removed when its process exits", t => {
  const root = fixture(t), modulePath = require.resolve("../src/modules/video/configuration");
  const code = `const p=require(${JSON.stringify(modulePath)}).prepare({userDataDir:process.env.TMPDIR,runtimeSettings:{uosc:false,timelinePreviews:false}});process.stdout.write(p.directory);`;
  const result = spawnSync(process.execPath, ["-e", code], { env: {...process.env, TMPDIR: root}, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);assert.equal(fs.existsSync(result.stdout), false);
});
test("a crashed player removes its session and a live player cannot be reclaimed", async t => {
  fixture(t);const session = Sessions.create(), value = await child(t, ["-e", "setInterval(()=>{},1000)", "--", "--config-dir=" + session.directory]);
  assert.equal(session.bind(value), true);session.cleanup();Sessions.reclaim();assert.ok(fs.existsSync(session.directory));
  value.kill("SIGKILL");await once(value, "close");assert.equal(fs.existsSync(session.directory), false);
});
test("the next playback reclaims a killed preparer after the handoff grace period", async t => {
  const root = fixture(t), modulePath = require.resolve("../src/modules/video/session-directory");
  const value = await child(t, ["-e", `const s=require(${JSON.stringify(modulePath)}).create();console.log(s.directory);setInterval(()=>{},1000);`]);
  const directory = await new Promise((resolve, reject) => {let text="";value.stdout.on("data", b => {text+=b;if(text.includes("\n"))resolve(text.trim());});value.once("error",reject);});
  // The child used this fixture's temporary root, never the user's temp sessions.
  assert.equal(path.dirname(directory), root);
  value.kill("SIGKILL");await once(value, "close");assert.ok(fs.existsSync(directory));
  Sessions.reclaim();assert.ok(fs.existsSync(directory), "an unbound recent handoff is retained");old(directory);
  Sessions.reclaim();assert.equal(fs.existsSync(directory), false);
});
test("legacy reclaim preserves live command-line owners, unrelated names and symlink targets", async t => {
  const root = fixture(t), legacy = path.join(root, "maclauncher-mpv-AbCd12"), unrelated = path.join(root, "maclauncher-mpv-not-a-session");
  fs.mkdirSync(legacy);fs.mkdirSync(path.join(legacy,"fonts"));fs.mkdirSync(path.join(legacy,"script-opts"));old(legacy);fs.mkdirSync(unrelated);
  const linked = path.join(root, "maclauncher-mpv-ZyXw98");fs.symlinkSync(unrelated, linked);
  const value = await child(t, ["-e", "setInterval(()=>{},1000)", "--", "--config-dir=" + legacy]);
  Sessions.reclaim();assert.ok(fs.existsSync(legacy));assert.ok(fs.existsSync(linked));
  value.kill("SIGKILL");await once(value, "close");Sessions.reclaim();assert.equal(fs.existsSync(legacy), false);assert.ok(fs.existsSync(unrelated));
});
test("an unbound live preparer is kept and permission-denied PID checks fail closed", t => {
  fixture(t);const session = Sessions.create();old(session.directory);
  Sessions.reclaim();assert.ok(fs.existsSync(session.directory));
  const marker = path.join(session.directory,Sessions.marker);fs.writeFileSync(marker,JSON.stringify({schema:1,pid:2147483647,player:true}));
  const mocked=t.mock.method(process,"kill",()=>{throw Object.assign(Error("denied"),{code:"EPERM"});});
  Sessions.reclaim();assert.ok(fs.existsSync(session.directory));mocked.mock.restore();session.cleanup();
});

test("legacy partial allocation without generated contents is reclaimed after its grace period", t => {
  const root=fixture(t), directory=path.join(root,"maclauncher-mpv-EfGh34");fs.mkdirSync(directory);old(directory);
  Sessions.reclaim();assert.equal(fs.existsSync(directory),false);
});

test("worker shutdown removes preparation that never reached a player", async t => {
  const root=fixture(t), {Worker}=require("node:worker_threads"), modulePath=require.resolve("../src/modules/video/configuration");
  const worker=new Worker(`const {parentPort}=require('node:worker_threads');const s=require(${JSON.stringify(modulePath)}).prepare({userDataDir:${JSON.stringify(root)},runtimeSettings:{uosc:false,timelinePreviews:false}});parentPort.postMessage(s.directory);`,{eval:true,env:{...process.env,TMPDIR:root}});
  t.after(()=>worker.terminate());const [directory]=await once(worker,"message");await once(worker,"exit");assert.equal(fs.existsSync(directory),false);
});
test("a live player remains protected after its launcher has been killed", async t => {
  const root=fixture(t), modulePath=require.resolve("../src/modules/video/session-directory");
  const producer=await child(t,["-e",`const s=require(${JSON.stringify(modulePath)}).create(),p=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(),5000)','--','--config-dir='+s.directory],{stdio:'ignore',detached:true});s.bind(p);p.unref();console.log(JSON.stringify({directory:s.directory,pid:p.pid}));setInterval(()=>{},1000);`]);
  const value=await new Promise((resolve,reject)=>{let data='';producer.stdout.on('data',b=>{data+=b;if(data.includes('\n'))resolve(JSON.parse(data.trim()));});producer.once('error',reject);});
  t.after(()=>{try{process.kill(value.pid,'SIGKILL');}catch{}});
  assert.equal(path.dirname(value.directory),root);producer.kill('SIGKILL');await once(producer,'close');
  Sessions.reclaim();assert.ok(fs.existsSync(value.directory),'the recorded player owns the folder after its preparer dies');
  process.kill(value.pid,'SIGKILL');
  for(let i=0;i<100;i++){try{process.kill(value.pid,0);}catch(error){if(error.code==='ESRCH')break;}await new Promise(resolve=>setTimeout(resolve,10));}
  Sessions.reclaim();assert.equal(fs.existsSync(value.directory),false);
});
test("owner marker creation failure removes the allocation and preserves its error", t => {
  const root=fixture(t), write=fs.writeFileSync, reason=Error("owner write failed");
  t.mock.method(fs,"writeFileSync",(file,...args)=>{if(path.basename(file)===Sessions.marker+'.tmp')throw reason;return write(file,...args);});
  assert.throws(()=>Sessions.create(),error=>error===reason);assert.deepEqual(fs.readdirSync(root),[]);
});
