const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn, execFileSync } = require("node:child_process"), { once } = require("node:events");
const Supervisor = require("../src/modules/android/service-processes");
test("profile preparation overlaps owners and retires every late acquisition",async t=>{
  for(const mode of ["ready","cancel","failure"])await t.test(mode,async t=>{
    const broker=require("../src/modules/android/platform-services/client"),pending=new Map(),closed=[];let released=0,settled=false;
    t.mock.method(require("../src/modules/android/platform-services/paths"),"paths",async(_,role)=>({platformSocket:"/fixture/"+role}));
    t.mock.method(broker,"retainExisting",async()=>null);
    t.mock.method(broker,"acquire",options=>new Promise((resolve,reject)=>pending.set(options.role,{resolve,reject})));
    const controller=new AbortController(),config={packageName:"example.concurrent"};
    const preparing=Supervisor.prepareConnections({config,signal:controller.signal,
      game:{metadata:{packageName:config.packageName},sourceApk:"/app.apk",nativeRoot:"/app/lib",filesRoot:"/app/data/files"},
      installed:{uid:10000,services:[],release:async()=>{released++;}},platformOptions:{systemServices:true},accountOptions:{account:null}});
    const owner=await preparing;settled=true;
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual([...pending.keys()],["keystore","system","accounts"],"account preparation begins before either platform owner becomes ready");
    const complete=role=>pending.get(role).resolve({socketPath:"/fixture/"+role,close:()=>closed.push(role)});
    complete("accounts");await Promise.resolve();assert.equal(settled,true,"supervisor preparation does not delay JVM startup on service readiness");
    if(mode==="cancel")controller.abort();
    if(mode==="failure")pending.get("system").reject(Error("actual owner failure"));else complete("system");
    complete("keystore");
    assert.deepEqual(owner.sandbox.localSockets.connect,["/fixture/keystore","/fixture/system","/fixture/accounts"]);
    await owner.close();await owner.close();
    assert.deepEqual(closed.sort(),mode==="failure"?["accounts","keystore"]:["accounts","keystore","system"]);
    assert.equal(released,1,"prepared package lease retires after all acquired services");
  });
});

test("anonymous and selected Google clients share the system account owner without changing account scope", { timeout: 5000 }, async t => {
  const broker = require("../src/modules/android/platform-services/client"), calls=[];
  const identity={packageName:"android",processName:"android:accounts",pid:200,uid:1000,hostUid:process.getuid?.()||0,securityContext:"u:r:system_server:s0"};
  t.mock.method(require("../src/modules/android/platform-services/boot-state"),"bootCount",async()=>1);
  t.mock.method(require("../src/modules/android/platform-services/paths"),"paths",async()=>({platformSocket:"/private/fixture/accounts.sock"}));
  t.mock.method(broker,"retainExisting",async()=>null);
  t.mock.method(broker,"acquire",async options=>{
    const call={options,enrolled:[],retired:[],closed:false};calls.push(call);
    return {identity,socketPath:"/private/fixture/accounts.sock",enroll:async(...args)=>call.enrolled.push(args),retire:async peer=>call.retired.push(peer),close:()=>{call.closed=true;}};
  });
  for(const account of [null,{name:"fixture-account",type:"com.google"}]) {
    const config={packageName:"example.provider"};
    const connections=await Supervisor.prepareConnections({config,
      game:{metadata:{packageName:config.packageName},sourceApk:"/provider.apk",nativeRoot:"/provider",filesRoot:"/provider/files"},
      installed:{uid:10010,services:[],release:async()=>{}},
      accountOptions:{userDataDir:"/private/fixture",account,networkAllowed:false}});
    const child=spawn(process.execPath,["-e",`
      const net=require('node:net'),{receive}=require(${JSON.stringify(path.resolve("src/modules/android/process-channel"))});
      const channel=new net.Socket({fd:5});receive(channel,value=>process.send(value),error=>{throw error;});
    `],{stdio:connections.stdio(["ignore","ignore","pipe","ipc"])});
    try {
      const incoming=once(child,"message");await connections.connect(child);const [authority]=await incoming;
      const call=calls.at(-1);assert.equal(call.options.role,"accounts");assert.equal(call.options.access,"game");
      assert.deepEqual(authority.accounts,{identity,socketPath:"/private/fixture/accounts.sock"});
      assert.deepEqual(authority.accountPolicy,{interactive:false});assert.equal(authority.self.uid,10010);
      assert.deepEqual(call.enrolled[0][0],authority.self);assert.deepEqual(call.enrolled[0][1].account,account);
      assert.equal(call.enrolled[0][1].networkAllowed,false);
      assert.deepEqual(connections.sandbox.localSockets.connect,["/private/fixture/accounts.sock"]);
      child.kill("SIGTERM");await once(child,"exit");await connections.close();
      assert.equal(call.closed,true);assert.deepEqual(call.retired,[authority.self]);
    }finally{await connections.close();if(child.exitCode==null&&child.signalCode==null)child.kill("SIGKILL");}
  }
  assert.equal(calls.length,2,"Anonymous mode also reaches the original remote system service");
});

test("clipboard requests authenticate their process and bound pending transfers", { timeout: 5000 }, async t => {
  const clipboard = require("../src/modules/android/clipboard");
  const calls = [], enrolled = new Set();
  t.mock.method(clipboard, "create", executable => ({
    enroll(pid) { enrolled.add(pid); }, retire(pid) { enrolled.delete(pid); }, close() {},
    transfer(pid, operation, text, options) { return new Promise(resolve => {
      assert.ok(enrolled.has(pid)); calls.push({ executable, pid, operation, text, options, resolve });
      options.signal.addEventListener("abort", () => resolve({ allowed: false }), { once: true });
    }); }
  }));
  const config = { packageName: "example.keyboard" };
  const connections = await Supervisor.prepareConnections({ config,
    game: { metadata: { packageName: config.packageName }, sourceApk: "/fixture.apk", nativeRoot: "/fixture", filesRoot: "/fixture/files" },
    installed: { uid: 10000, services: [], release: async () => {} }, descriptorSender: "/runtime/native/android-supervisor-send" });
  const child = spawn(process.execPath, ["-e", `
    const net=require('node:net'), {frame,receive}=require(${JSON.stringify(path.resolve("src/modules/android/process-channel"))});
    const channel=new net.Socket({fd:5});
    receive(channel,value=>process.send(value),error=>{throw error;});
    process.on('message',value=>channel.write(frame(value)));
  `], { stdio: connections.stdio(["ignore", "ignore", "pipe", "ipc"]) });
  const messages = [], nextMessage = () => new Promise(resolve => {
    const poll = () => messages.length ? resolve(messages.shift()) : setTimeout(poll, 5);
    poll();
  });
  child.on("message", value => messages.push(value));
  try {
    await connections.connect(child); await nextMessage();
    child.send({ op: "clipboard", requestId: "1", operation: "paste", pid: process.pid });
    while (!calls.length) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls[0].pid, child.pid, "Guest-supplied PID cannot authorize another application");
    assert.equal(calls[0].executable, "/runtime/native/android-clipboard");
    child.send({ op: "clipboard", requestId: "2", operation: "paste" });
    assert.deepEqual(await nextMessage(), { op: "clipboard", requestId: "2", allowed: false });
    assert.equal(calls.length, 1, "Repeated guest requests cannot accumulate native helpers");
    calls[0].resolve({ allowed: true, text: "local fixture text" });
    assert.deepEqual(await nextMessage(), { op: "clipboard", requestId: "1", allowed: true, text: "local fixture text" });
    child.send({ op: "clipboard", requestId: "3", operation: "copy", text: "selection" });
    while (calls.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
    child.kill("SIGTERM"); await once(child, "exit"); await connections.close();
    assert.equal(calls[1].options.signal.aborted, true, "Retiring a process also retires its clipboard operation");
  } finally {
    await connections.close();
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
});

test("a supervisor-owned presenter supplies the app gesture identity until either process retires", { timeout: 5000 }, async t => {
  const calls=[],enrolled=new Set();
  t.mock.method(require("../src/modules/android/clipboard"),"create",()=>({
    enroll:pid=>enrolled.add(pid),retire:pid=>enrolled.delete(pid),close(){},
    transfer:async pid=>{assert.ok(enrolled.has(pid));calls.push(pid);return {allowed:true,text:"explicit paste"};}
  }));
  const config={packageName:"example.native"};
  const owner=await Supervisor.prepareConnections({config,processIdentityVersion:1,game:{metadata:{packageName:config.packageName},sourceApk:"/app.apk",nativeRoot:"/app/lib",filesRoot:"/app/files"},installed:{uid:10023,services:[],release:async()=>{}},descriptorSender:"/runtime/native/android-supervisor-send"});
  const child=spawn(process.execPath,["-e",`
    const net=require('node:net'),{frame,receive}=require(${JSON.stringify(path.resolve("src/modules/android/process-channel"))});
    const channel=new net.Socket({fd:5});channel.write(frame({op:'identity',pid:123,hostPid:process.pid}));receive(channel,value=>process.send(value),error=>{throw error;});
    process.on('message',value=>channel.write(frame(value)));
  `],{stdio:owner.stdio(["ignore","ignore","pipe","ipc"])});
  const presenter=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
  try{
    const bootstrap=once(child,"message");await owner.connect(child,{presentation:presenter});const [packet]=await bootstrap;
    assert.equal(packet.self.pid,123);assert.equal(packet.self.hostPid,child.pid);
    assert.deepEqual([...enrolled],[presenter.pid]);
    let response=once(child,"message");child.send({op:"clipboard",requestId:"1",operation:"paste",pid:process.pid});
    assert.deepEqual((await response)[0],{op:"clipboard",requestId:"1",allowed:true,text:"explicit paste"});
    assert.deepEqual(calls,[presenter.pid],"The inherited app channel cannot substitute its requested PID");
    const exited=once(presenter,"exit");presenter.kill();await exited;assert.equal(enrolled.size,0);
    response=once(child,"message");child.send({op:"clipboard",requestId:"2",operation:"paste"});
    assert.deepEqual((await response)[0],{op:"clipboard",requestId:"2",allowed:false});
    assert.equal(calls.length,1,"A surviving app cannot reuse its retired window's gesture capability");
  }finally{
    if(child.exitCode==null&&child.signalCode==null){const exit=once(child,"exit");child.kill();await exit;}
    if(presenter.exitCode==null&&presenter.signalCode==null){const exit=once(presenter,"exit");presenter.kill();await exit;}
    await owner.close();
  }
});

test("native window close intent belongs to its inherited process channel", { timeout: 5000 }, async t => {
  const config = { packageName: "example.window" };
  const connections = await Supervisor.prepareConnections({ config,
    game: { metadata: { packageName: config.packageName }, sourceApk: "/fixture.apk", nativeRoot: "/fixture", filesRoot: "/fixture/files" },
    installed: { uid: 10000, services: [], release: async () => {} } });
  const child = spawn(process.execPath, ["-e", `
    const net=require('node:net'),fs=require('node:fs');
    const channel=new net.Socket({fd:5});
    channel.once('data',()=>{
      const body=Buffer.from(JSON.stringify({op:'window-close'})),frame=Buffer.alloc(4+body.length);
      frame.writeUInt32BE(body.length);body.copy(frame,4);
      channel.write(frame,()=>process.kill(process.pid,'SIGKILL'));
    });`], { stdio: connections.stdio(["ignore", "ignore", "pipe"]) });
  try {
    const stopped = once(child, "stopRequested"), exited = once(child, "exit");
    await connections.connect(child);
    await stopped;
    assert.equal(child.stopRequested, true);
    const [code, signal] = await exited;
    assert.equal(code, null); assert.equal(signal, "SIGKILL");
  } finally {
    await connections.close();
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
});

test("Demanded Android processes share one bidirectional Binder session and retire transferred capabilities", { timeout: 35000 }, async t => {
  const runtime = process.env.KLEPTON_NATIVE_RUNTIME, home = process.env.JAVA_HOME;
  if (process.platform !== "darwin" || !runtime || !home)
    return t.skip("Requires macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME");
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "android-process-authority-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const cp = [temporary, ...["android-host.jar", "android-framework.jar"].map(name => path.resolve(runtime, name))].join(path.delimiter);
  execFileSync(path.join(home, "bin/javac"), ["--release", "21", "-cp", cp, "-d", temporary,
    ...["framework/HostPackages", "framework/HostProcessServices", "framework/HostRemoteServices", "framework/HostServiceDirectory", "ProcessAuthority"]
      .map(name => path.resolve("src/modules/android/native/java/maclauncher/android", name + ".java")),
    ...["ProcessSocketProbe", "ProcessDirectoryProbe"].map(name => path.resolve("tests/fixtures/android-process-authority", name + ".java")),
    path.resolve("tests/fixtures/android-window-session/RuntimeFixture.java"),
    path.resolve("tests/fixtures/android-framework-services/SyntheticResources.java")], { stdio: "pipe" });
  const { frameworkJvmOptions } = require("../src/modules/android/jvm-options");
  const env = { ...process.env, ...require("./helpers/android-java").processNamespace(temporary) };
  for (const scenario of ["ProcessSocketProbe", "ProcessDirectoryProbe", "PeerRetirement"]) await t.test(scenario, async () => {
    const unavailable = scenario === "PeerRetirement", probe = unavailable ? "ProcessSocketProbe" : scenario;
    const children = [], config = { packageName: "example.game" };
    let released = 0, spawned = 0;
    const prepared = name => ({ metadata: { packageName: name }, filesRoot: temporary,
      sourceApk: path.join(temporary, "fixture.apk"), nativeRoot: temporary });
    function launch(role, stdio) {
      const data = fs.mkdtempSync(path.join(temporary, role + "-"));
      const child = spawn(path.join(home, "bin/java"), [...frameworkJvmOptions, "-Xverify:all", "-cp", cp,
        "maclauncher.android." + probe, path.resolve(runtime), data, role],
      { stdio: stdio.map((value, index) => index === 1 ? "pipe" : value), detached: true, env });
      children.push(child);
      let stdout = "", stderr = "";
      child.stdout.on("data", value => { stdout += value; });
      child.stderr.on("data", value => { stderr += value; });
      child.result = () => ({ stdout, stderr, code: child.exitCode, signal: child.signalCode });
      return child;
    }
    const connections = await Supervisor.prepareConnections({ config, game: prepared(config.packageName), processIdentityVersion: 1,
      installed: { uid: 10000, services: ["needed", "second", "unused", "also-unused"].map(name => ({
        record: { packageName: "example.service", processName: "example.service:" + name, uid: 10001 },
        prepared: prepared("example.service") })), release: async () => { released++; } },
      descriptorSender: process.env.ANDROID_SUPERVISOR_SENDER || path.resolve(runtime, "native/android-supervisor-send"),
      launchService: async (service, fields, stdio, sandbox) => {
        spawned++; assert.ok(["example.service:needed", "example.service:second"].includes(service.record.processName));
        assert.equal(fields.authorityFd, 5); assert.equal(fields.serviceFd, undefined);
        assert.equal(stdio.length, 6, "No reserved peer descriptor graph");
        assert.equal(sandbox.installedPackages.length, 2);
        const child = launch(unavailable ? "leave" : service.record.processName.endsWith(":second") ? "second" : "service", stdio); await once(child, "spawn"); return child;
      } });
    try {
      assert.equal(spawned, 0, "Declaration does not start an idle provider");
      const game = launch(unavailable ? "game-unavailable" : "game", connections.stdio(["ignore", "pipe", "pipe", "ignore"]));
      await once(game, "spawn"); await connections.connect(game);
      const expected = unavailable ? '"unavailable":true' : '"echo":true';
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline && (!game.result().stdout.includes(expected) ||
        (probe === "ProcessDirectoryProbe" && (!children[1]?.result().stdout.includes('"reverse":true') || !game.result().stdout.includes('"reconnected":true'))))) {
        if ((unavailable ? [game] : children).some(child => child.exitCode != null || child.signalCode != null)) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const details = JSON.stringify(children.map(child => child.result()));
      assert.ok(game.result().stdout.includes(expected), details);
      if (probe === "ProcessDirectoryProbe") assert.match(children[1].result().stdout, /"reverse":true/, details);
      if (probe === "ProcessDirectoryProbe") assert.match(game.result().stdout, /"reconnected":true/, details);
      assert.equal(spawned, probe === "ProcessDirectoryProbe" ? 2 : 1, "Nested demand starts its provider; unused providers remain stopped");
      assert.equal(connections.sandbox.rpcRoot, undefined, "No filesystem socket namespace or listener exists");
      game.kill("SIGTERM"); await once(game, "exit"); await connections.close();
      assert.equal(children[1].exitCode, 0, JSON.stringify(children[1].result()));
      assert.equal(released, 1);
    } finally {
      await connections.close();
      for (const child of children) if (child.exitCode == null && child.signalCode == null)
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  });
});
