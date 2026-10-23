const { spawn } = require("node:child_process");
const MAX_FRAME = 1024 * 1024;
const writes = new WeakMap();
const identities = new WeakMap();

function enqueue(stream, operation) {
  const next=(writes.get(stream)||Promise.resolve()).catch(()=>{}).then(operation);
  writes.set(stream,next);return next;
}

function frame(value) {
  const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  if (bytes.length > MAX_FRAME) throw Error("Android process message exceeds the supported size.");
  header.writeUInt32BE(bytes.length); return Buffer.concat([header, bytes]);
}

function receive(stream, accept, failed) {
  let pending = Buffer.alloc(0), stopped = false;
  const error = reason => { if (!stopped) { stopped = true; failed(reason); } };
  stream.on("error", error);
  stream.on("data", chunk => {
    if (stopped) return;
    try {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const size = pending.readUInt32BE(0);
        if (size < 2 || size > MAX_FRAME) throw Error("Invalid Android process message size.");
        if (pending.length < size + 4) return;
        const value = JSON.parse(pending.subarray(4, size + 4)); pending = pending.subarray(size + 4);
        accept(value);
      }
    } catch (reason) { error(reason); }
  });
}

function send(stream, value) {
  return enqueue(stream,()=>new Promise((resolve, reject) => {
    if (stream.destroyed || !stream.writable) return reject(Error("Android platform connection is closed."));
    stream.write(frame(value), error => error ? reject(error) : resolve());
  }));
}

async function processNamespace(userDataDir, version = 0) {
  if (version !== 0 && version !== 1) throw Error("The Android process identity protocol is unsupported.");
  if (version !== 1) return { environment: {}, writeDirectories: [] };
  const fs = require("node:fs/promises"), path = require("node:path");
  const { privateDirectory } = require("./platform-services/paths");
  const profile = await fs.realpath(userDataDir), android = path.join(profile, "android");
  await fs.mkdir(android, { recursive: true, mode: 0o700 });
  const directory = await privateDirectory(path.join(android, "process-ids"));
  return { environment: { KL_ANDROID_ID_DIRECTORY: directory }, writeDirectories: [directory] };
}

// Read exactly one packet before transferring the same descriptor to the
// ordinary authority reader. No second data listener consumes later packets.
function firstPacket(child) {
  const stream = child.stdio?.[5];
  if (!stream?.readable) return Promise.reject(Error("Android process authority descriptor is unavailable."));
  return new Promise((resolve, reject) => {
    let size;
    const cleanup = () => { stream.removeListener("readable", read); stream.removeListener("error", failed);
      stream.removeListener("end", closed); stream.removeListener("finish", closed); stream.removeListener("close", closed);
      child.removeListener("exit", ended); child.removeListener("error", failed); };
    const failed = error => { cleanup(); reject(error); };
    const ended = () => failed(Error("Android process stopped before publishing its identity."));
    const closed = () => failed(Error("Android process authority closed before publishing its identity."));
    const read = () => {
      try {
        if (size === undefined) {
          const header = stream.read(4); if (!header) return;
          size = header.readUInt32BE(0);
          if (size < 2 || size > MAX_FRAME) throw Error("Invalid Android process identity size.");
        }
        const bytes = stream.read(size); if (!bytes) return;
        const value = JSON.parse(bytes); cleanup(); resolve(value);
      } catch (error) { failed(error); }
    };
    // Enrollment follows the actual process/channel lifetime. A second wall
    // clock deadline here used to reject live ART initialization under load;
    // the launch owner already cancels its child and closes this descriptor.
    stream.on("readable", read); stream.once("error", failed); stream.once("end", closed);
    stream.once("finish", closed); stream.once("close", closed);
    child.once("exit", ended); child.once("error", failed);
    read();
  });
}

async function processIdentity(child, { version = 0 } = {}) {
  if (version !== 0 && version !== 1) throw Error("The Android process identity protocol is unsupported.");
  if(!Number.isSafeInteger(child.pid)||child.pid<2||child.exitCode!=null||child.signalCode!=null)
    throw Error('Android process identity has no live native owner.');
  // Immutable older runtime contracts use physical IDs. The selected native
  // contract, never a timing guess, determines whether an identity packet exists.
  if (version !== 1) return {pid:child.pid,hostPid:child.pid};
  let identity = identities.get(child);
  if (!identity) {
    identity = firstPacket(child).then(value => {
      if (value.op !== "identity" || value.hostPid !== child.pid || !Number.isSafeInteger(value.pid) || value.pid < 2 || value.pid > 65535)
        throw Error("Android process identity does not match its native owner.");
      if(value.androidId!==undefined&&(typeof value.androidId!=="string"||!/^[0-9a-f]{16}$/.test(value.androidId)))throw Error("Android application identity is invalid.");
      return { pid: value.pid, hostPid: child.pid, ...(value.androidId!==undefined?{androidId:value.androidId}:{}) };
    });
    identities.set(child, identity);
  }
  return identity;
}

function helperCommand(helper, args, descriptor, { maximumOutput = 16384, signal } = {}) {
  return new Promise((resolve, reject) => {
    if(signal?.aborted)return reject(signal.reason);
    // Borrow the numeric FD. Passing its stream would transfer Node's reader.
    const child = spawn(helper, args, { stdio: ["ignore", "pipe", "pipe", descriptor ?? "ignore"] });
    let output = "", detail = "", overflow = false;
    const abort=()=>child.kill("SIGKILL");signal?.addEventListener("abort",abort,{once:true});
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000); timer.unref();
    child.stdout.on("data", value => { output += value; if (output.length > maximumOutput) { overflow = true; child.kill("SIGKILL"); } });
    child.stderr.on("data", value => { detail = (detail + value).slice(-4096); });
    child.once("error", error => { clearTimeout(timer);signal?.removeEventListener("abort",abort);reject(error); });
    // The process can exit before Node has drained its response pipe.
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort",abort);
      if(signal?.aborted)return reject(signal.reason);
      if (code !== 0 || overflow) return reject(Error("Android process identity failed: " + (detail.trim() || signal || code)));
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
  });
}

/** The parent owns this namespace capability. The sandboxed process asks for
 * fresh candidates without choosing a path or gaining host process access.
 * Its existing native lease owner authenticates the returned candidates. */
function prepareProcessQuerySpawn(options, helper, { query = helperCommand } = {}) {
  const directory=options.env?.KL_ANDROID_ID_DIRECTORY;
  if(!directory)return {options,attach(){}};
  const stdio=[...(options.stdio||["pipe","pipe","pipe"])];
  while(stdio.length<3)stdio.push("pipe");
  const descriptor=stdio.length;stdio.push("pipe");
  return {options:{...options,stdio,env:{...options.env,KL_ANDROID_PROCESS_QUERY_FD:String(descriptor)}},attach(child){
    const stream=child.stdio?.[descriptor];if(!stream)return;
    const cancellation=new AbortController();let busy=false;
    const close=()=>{cancellation.abort(Error("Android process query owner retired."));stream.destroy();};
    stream.on("error",()=>{});stream.once("close",()=>cancellation.abort(Error("Android process query channel closed.")));
    child.once("exit",close);child.once("error",close);
    stream.on("data",bytes=>{
      if(busy||bytes.length!==1||bytes[0]!==1){close();return;}
      busy=true;
      Promise.resolve().then(()=>query(helper,["--namespace-processes",directory],undefined,{maximumOutput:MAX_FRAME,signal:cancellation.signal})).then(value=>{
        if(!Array.isArray(value.pids)||!value.pids.every(pid=>Number.isSafeInteger(pid)&&pid>0&&pid<=0x7fffffff))throw Error("Invalid Android process candidates");
        const pids=[...new Set(value.pids)],reply=Buffer.alloc(4+pids.length*4);reply.writeUInt32BE(pids.length);
        pids.forEach((pid,index)=>reply.writeUInt32BE(pid,4+index*4));return reply;
      }).catch(()=>Buffer.from([255,255,255,255])).then(reply=>{
        if(!stream.destroyed)stream.write(reply,error=>{busy=false;if(error)close();});
      });
    });
  }};
}

module.exports = { MAX_FRAME, frame, receive, send, enqueue, helperCommand, processIdentity, processNamespace, prepareProcessQuerySpawn };
