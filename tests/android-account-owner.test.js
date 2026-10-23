const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events"), { Duplex, PassThrough } = require("node:stream");
const { createAccountControl } = require("../src/modules/android/account-control");
const Owner = require("../src/modules/android/account-owner"), Catalog = require("../src/modules/android/service-packages");
const Preparation = require("../src/modules/android/prepare"), Storage = require("../src/modules/android/storage");
const Runtime = require("../src/modules/android/runtime"), Sandbox = require("../src/modules/android/sandbox");
const Java = require("../src/modules/java/runtime/java-runtime-manager"), Processes = require("../src/core/processes");

function frame(value) {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32BE(body.length); return Buffer.concat([header, body]);
}

test("package removal keeps the selected account runtime without acquisition", async () => {
  const context = { userDataDir: "/profile", settings: { runtimes: { android: { defaultVersion: "managed" } } } };
  const payload = { root: "/managed/runtime", runtimeIdentity: { version: "managed" }, profile: { frameworkServicesVersion: 1 } };
  const events = [];
  await Owner.removePackages(context, ["example.removed"], {
    resolveForAccounts: async (actual, options) => { assert.equal(actual, context);assert.deepEqual(options, { install: false });return payload; },
    acquire: async (actual, options, dependencies) => {
      assert.equal(actual, context);assert.deepEqual(options, { blockNetwork: true, access: "manage" });
      assert.equal(await dependencies.resolveRuntime(), payload);
      return { identity: { frameworkServicesVersion: 1 }, request: async (...args) => events.push(args), release: () => events.push("release") };
    }
  });
  assert.deepEqual(events, [["removePackages", { packages: ["example.removed"] }], "release"]);
  await assert.rejects(Owner.removePackages(context, ["example.removed"], {
    resolveForAccounts: async (_actual, options) => { assert.equal(options.install, false);throw Error("Selected runtime unavailable"); },
    acquire: () => assert.fail("Unavailable selection must not acquire another runtime")
  }), /Selected runtime unavailable/);
});

test("Account control preserves real results, handles split frames, and cancels the matching original session", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  const sent = [], stream = new Duplex({ read() {}, write(bytes, _encoding, done) { sent.push(JSON.parse(bytes.subarray(4))); done(); } });
  const control = createAccountControl({ child, control: stream });
  const first = control.request("accounts"), cancel = new AbortController();
  const cancelled = control.request("removeAccount", { name: "private", type: "fixture" }, { signal: cancel.signal });
  const rejection = assert.rejects(cancelled, { code: "ABORT_ERR" }); cancel.abort(); await rejection;
  assert.equal(sent.length, 3);
  assert.equal(sent[2].command, "cancel"); assert.equal(sent[2].payload.id, sent[1].id);
  const response = frame({ schemaVersion: 1, id: sent[0].id, result: { accounts: [] } });
  stream.push(response.subarray(0, 2)); stream.push(response.subarray(2, 9)); stream.push(response.subarray(9));
  assert.deepEqual(await first, { accounts: [] });
  stream.push(frame({ schemaVersion: 1, id: sent[1].id, result: { completed: true } }));
  const failed = control.request("addAccount", { type: "fixture" });
  stream.push(frame({ schemaVersion: 1, id: sent[3].id, error: { code: 6, message: "private-token", type: "java.lang.SecurityException", site: "android.accounts.AccountManager.check:42" } }));
  await assert.rejects(failed, error => error.code === "ACCOUNT_PROVIDER_ERROR" && error.providerCode === 6 && !error.message.includes("private-token") && error.providerFailureType === "java.lang.SecurityException" && error.providerFailureSite === "android.accounts.AccountManager.check:42");
  const invalidDiagnostic=control.request("accounts");
  stream.push(frame({schemaVersion:1,id:sent.at(-1).id,error:{code:6,type:"private@example.com",site:"https://example.com/private-token"}}));
  await assert.rejects(invalidDiagnostic,error=>error.code==="ACCOUNT_PROVIDER_ERROR"&&!error.providerFailureType&&!error.providerFailureSite&&!error.message.includes("private-token"));
  const pending = control.request("accounts"), closed = assert.rejects(pending, { code: "ACCOUNT_CONTROL_EOF" });
  stream.push(null); await closed;
  assert.equal(stream.listenerCount("data"), 0); assert.equal(child.listenerCount("exit"), 0);
  stream.destroy();
});

test("Account leases delegate profile ownership and cancel only their controller", async t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"android-accounts-")));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const runtimeIdentity={version:"selected",minimumMacOS:"13.0",manifestSha256:"selected-manifest"};
  const payload={root,runtimeIdentity,profile:{accountControlVersion:1,accountActivityVersion:1}}, calls=[];
  const dependencies={resolveRuntime:async()=>payload,java:{javaPath:"/installed/java"},acquireBroker:async options=>{
    const owner={options,closed:false,requests:[]};calls.push(owner);
    return {identity:{uid:1000},socketPath:"/profile/accounts.sock",enroll:async()=>{},retire:async()=>{},close:()=>{owner.closed=true;},request:async(...args)=>{owner.requests.push(args);return {accounts:[]};}};
  }};
  const first=await Owner.acquire({userDataDir:root},{blockNetwork:true},dependencies);
  const controller=new AbortController();
  const second=await Owner.acquire({userDataDir:root,signal:controller.signal},{blockNetwork:false},dependencies);
  assert.equal(calls[0].options.role,"accounts");assert.equal(calls[0].options.access,"read");assert.equal(calls[1].options.access,"manage");
  assert.equal(calls[0].options.runtimeIdentity,runtimeIdentity,"Account leases retain the launch's immutable runtime identity");
  await first.request("accounts");await second.request("addAccount",{type:"com.google"});
  assert.equal(calls[0].requests[0][2].networkAllowed,false);assert.equal(calls[1].requests[0][2].networkAllowed,true);
  controller.abort();assert.equal(calls[1].closed,true);assert.equal(calls[0].closed,false);
  first.release();first.release();assert.equal(calls[0].closed,true);
});

test("Account bootstrap failures retain their actual phase before the adapter returns", async t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"android-account-bootstrap-")));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const read=Catalog.read,prepare=Storage.prepareStorage;
  t.after(()=>{Catalog.read=read;Storage.prepareStorage=prepare;});
  const config={userDataDir:root,runtimeRoot:root,javaPath:"/installed/java"};
  const {lifecycleFailure}=require("../src/modules/android/account-stages");
  const catalog=Object.assign(Error("PRIVATE_CATALOG_PATH"),{code:"EACCES"});
  Catalog.read=()=>{throw catalog;};
  await assert.rejects(Owner.startProfileService(config,{},undefined),error=>{
    assert.equal(error,catalog);
    assert.deepEqual(lifecycleFailure(error,"start-service"),{stage:"read-provider-catalog",type:"Error",sites:[],causes:[],code:"EACCES"});
    return true;
  });
  Catalog.read=()=>({packages:[]});
  const storage=Object.assign(TypeError("PRIVATE_STORAGE_PATH"),{code:"EBUSY"});
  Storage.prepareStorage=async()=>{throw storage;};
  await assert.rejects(Owner.startProfileService(config,{},undefined,{payload:{root,profile:{frameworkServicesVersion:1}}}),error=>{
    assert.equal(error,storage);
    const retained=lifecycleFailure(error,"start-service");
    assert.deepEqual(retained,{stage:"prepare-account-storage",type:"TypeError",sites:[],causes:[],code:"EBUSY"});
    assert.doesNotMatch(JSON.stringify(retained),/PRIVATE|Users|installed/);
    return true;
  });
});
