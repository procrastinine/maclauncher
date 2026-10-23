const { spawn } = require("node:child_process"), path = require("node:path");
const { randomUUID } = require("node:crypto");
const { frame, receive, enqueue: enqueueChannel } = require("./process-channel");
function descriptor(prepared, uid, record = {}) {
  // APK preparations have the converter's content identity. Framework payloads
  // also expose a root, but their immutable bytes belong to the runtime owner.
  const preparation=typeof prepared.root==="string"&&
    require("./prepared-cache").generationKey(path.basename(prepared.root))===prepared.key&&
    /^[a-f0-9]{64}$/.test(prepared.apkSha256||"");
  return { packageName: prepared.metadata.packageName, sourceApks: prepared.sourceApks || [prepared.sourceApk],
    ...(preparation?{preparedRoot:prepared.root,apkSha256:prepared.apkSha256}:{}),
    convertedJar: prepared.convertedJar, nativeRoot: prepared.nativeRoot, dataRoot: path.dirname(prepared.filesRoot), uid,
    firstInstallTime: record.firstInstallTime || 0, lastUpdateTime: record.lastUpdateTime || 0 };
}
const key = (packageName, processName) => JSON.stringify([packageName, processName]);
const live = child => child && child.exitCode == null && child.signalCode == null;
function profileRequests({platformOptions,accountOptions,platformOwners}){
  const requests=[];
  if(platformOptions){
    if(!platformOwners?.platform)requests.push({role:"keystore",packageName:"android.keystore",processName:"android.keystore",options:{...platformOptions,role:"keystore"}});
    if(platformOptions.systemServices&&!platformOwners?.system)requests.push({role:"system",packageName:"android",processName:"android.system",options:{...platformOptions,role:"system"}});
  }
  if(accountOptions&&!platformOwners?.accounts)requests.push({role:"accounts",packageName:"android",processName:"android.accounts",options:{...accountOptions,role:"accounts",access:"game"}});
  return requests;
}
/** A compatible existing owner remains leased across package preparation. */
async function reserveProfileOwners(options,reservation){
  if(!reservation){
    const owners=new Map();let closing;
    reservation={owners,get closed(){return !!closing;},close(){return closing??=(async()=>{const {retireAll}=await import('./art/process-retirement.mjs');await retireAll([...owners].map(([role,owner])=>async()=>{await owner.close();owners.delete(role);}));})();}};
  }
  try{
    if(reservation.closed)throw Error("Android platform reservation was released.");
    for(const request of profileRequests(options))if(!reservation.owners.has(request.role)){
      const owner=await require("./platform-services/client").retainExisting({...request.options,signal:options.signal});
      if(reservation.closed){await owner?.close();throw Error("Android platform reservation was released.");}
      if(owner)reservation.owners.set(request.role,owner);
    }
    return reservation;
  }catch(error){await reservation.close();throw error;}
}
async function processIdentity(child, packageName, processName, uid, version) {
  const ids=await require('./process-channel').processIdentity(child,{version});
  return { packageName, processName, ...ids, uid, hostUid: process.getuid?.() ?? 0,
    ...(uid === 1000 && packageName === "android" ? { securityContext: "u:r:system_server:s0" } : {}) };
}

/** One supervisor owns process demand, authenticated capabilities and retirement. */
async function prepareConnections({ userDataDir, installed, game, config, launchService, signal, logger, descriptorSender, platformOptions, serviceOwners, accountOptions, platformOwners, profileReservation, processIdentityVersion = 0, lazyProfileServicesVersion = 0 }) {
  const {retireAll,stopProcess,stopProcesses,requireRetired}=await import('./art/process-retirement.mjs');
  const services = installed.services;
  const packages = [descriptor(game, installed.uid), ...new Map(services
    .filter(item => item.record.packageName !== game.metadata.packageName)
    .map(item => [item.record.packageName, descriptor(item.prepared, item.record.uid, item.record)])).values()];
  const gameProcess = game.metadata.launcherProcesses?.[config.activityClass] || game.metadata.applicationProcessName || config.packageName;
  Object.assign(config, { processName: gameProcess, installedPackagesJson: JSON.stringify(packages), authorityFd: 5 });
  // Android process ownership is (uid, declared process), including signed
  // shared-user packages. Package keys remain aliases for ordinary demand.
  function processSlots(values){const owners=new Map(),aliases=new Map();for(const service of [...values].sort((a,b)=>a.record.packageName.localeCompare(b.record.packageName))){
    const id=key(service.record.uid,service.record.processName);let slot=owners.get(id);
    if(!slot){slot={service};owners.set(id,slot);}aliases.set(key(service.record.packageName,service.record.processName),slot);
  }return aliases;}
  const slots = processSlots(services.filter(service => service.record.uid !== installed.uid || service.record.processName !== gameProcess));
  const children = new Set(), routes = new Map(), helpers = new Set(), stopping = new Map(), clipboard = new Map(), consumers = new Set();
  let gameChild, gameIdentity, closed = false, closing, acquiring, connecting, platform, system, accounts, bootCount;
  const borrowedOwners=new Set(Object.values(platformOwners||{}));
  const composition=platformOwners?.composition;
  ({platform,system,accounts}={...{platform,system,accounts},...platformOwners});
  const clipboardOwner = descriptorSender ? require("./clipboard").create(path.join(path.dirname(descriptorSender), "android-clipboard")) : null;
  const sandbox = { installedPackages: packages };
  // These are the existing profile process owners, not running services. Their
  // endpoint paths can be granted before any consumer asks them to start.
  const requestedProfiles=profileRequests({platformOptions,accountOptions,platformOwners});
  const lazyProfiles=lazyProfileServicesVersion===1;
  if(lazyProfiles)for(const request of requestedProfiles)slots.set(key(request.packageName,request.processName),{profile:request});
  const declaredOwners={...(lazyProfiles?Object.fromEntries(requestedProfiles.map(request=>[request.role==="accounts"?"account":request.role,{packageName:request.packageName,processName:request.processName}])):{}),...serviceOwners};
  function initializing(child) {
    signal?.throwIfAborted();
    if (closed) throw Error("Android service startup was cancelled.");
    if (!live(child)) throw Error("The Android process exited during service registration.");
  }
  async function initialize(child, identity, slot, stage = () => {}) {
    if(identity.androidId!==undefined){const installed=packages.find(value=>value.packageName===identity.packageName&&value.uid===identity.uid);if(installed)installed.androidId=identity.androidId;}
    for (const owner of [platform, system].filter(Boolean)) {
      stage(owner === system ? "enroll-system" : "enroll-keystore");
      initializing(child);
      await owner.enroll(identity, owner === system ? { packages } : undefined);
      child.once("exit", () => { void owner.retire(identity).catch(() => {}); });
      // An exit between PID admission and listener installation cannot leave a
      // stale service principal in a retained profile owner.
      try { initializing(child); }
      catch(error) { await owner.retire(identity); throw error; }
    }
    // Only this launch's foreground process receives layer capabilities.
    // Installed providers retain their existing service/data authority.
    const displayOwner=child===gameChild?composition:null;
    if(displayOwner){stage("enroll-composition");initializing(child);await displayOwner.enroll(identity);child.once("exit",()=>{void displayOwner.retire(identity).catch(()=>{});});try{initializing(child);}catch(error){await displayOwner.retire(identity);throw error;}}
    if (accounts) {
      stage("enroll-accounts");
      initializing(child);
      await accounts.enroll(identity, { packages, account: accountOptions?.account || null, networkAllowed: accountOptions?.networkAllowed === true });
      child.once("exit", () => { void accounts.retire(identity).catch(() => {}); });
      try { initializing(child); }
      catch(error) { await accounts.retire(identity); throw error; }
    }
    // Game and provider startup never opens account UI, including anonymous
    // launches with no account broker. Explicit account tools own interaction.
    const bootstrap={ schemaVersion: 2, self: identity, ...(bootCount!==undefined?{bootCount}:{}),
      accountPolicy: { interactive: config.accountService===1&&!accountOptions },
      ...(accountOptions&&accounts ? { accounts: { identity: accounts.identity, socketPath: accounts.socketPath } } : {}), ...(Object.keys(declaredOwners).length ? { serviceOwners: declaredOwners } : {}),
      ...(platform ? { platform: { identity: platform.identity, socketPath: platform.socketPath } } : {}),
      ...(system ? { system: { identity: system.identity, socketPath: system.socketPath } } : {}),
      ...(displayOwner ? { composition: { identity: displayOwner.identity, socketPath: displayOwner.socketPath,display:displayOwner.display } } : {}) };
    stage("send-initialization");initializing(child); await send(child,bootstrap);
  }

  function stop(child) {
    if (!live(child)) return Promise.resolve();
    if (stopping.has(child)) return stopping.get(child);
    const result = retireAll([
      ()=>child.stdio?.[5]?.end(),
      ()=>stopProcess(child,{initialSignal:null})
    ]);
    stopping.set(child, result); return result;
  }
  function channel(child) {
    const stream = child.stdio?.[5];
    if (closed || !live(child) || !stream?.writable) throw Error("The Android service authority channel is closed.");
    return stream;
  }
  function borrowedDescriptor(child) {
    const stream = channel(child), fd = stream.fd ?? stream._handle?.fd;
    if (!Number.isSafeInteger(fd) || fd < 0) throw Error("The Android service authority descriptor is closed.");
    return fd;
  }
  // Every writer, including a two-process descriptor transfer, joins the same
  // per-channel queue. No JSON frame can split an ancillary descriptor frame.
  async function enqueue(targets, operation) {
    const ordered=[...new Set(targets)].sort((a,b)=>a.pid-b.pid);
    const acquire=index=>index===ordered.length?operation():enqueueChannel(channel(ordered[index]),()=>acquire(index+1));
    return acquire(0);
  }
  async function send(child, value) {
    const bytes = frame(value);
    return enqueue([child], () => new Promise((resolve, reject) => {
      channel(child).write(bytes, error => error ? reject(error) : resolve());
    }));
  }
  function connectPair(from, fromIdentity, destination, connectionId) {
    return enqueue([from, destination.child], () => new Promise((resolve, reject) => {
      if(closed||!live(from)||!live(destination.child)){reject(Error("Android connection was retired."));return;}
      const server = borrowedDescriptor(destination.child), client = borrowedDescriptor(from);
      // Only authority channels are inherited. The native helper creates and
      // transfers the data socketpair; the launcher never owns data streams.
      // Passing a stream object to spawn transfers its readable side to the
      // child and pauses Node's reader. Borrow descriptors instead: this helper
      // only writes, and the supervisor remains the channel's sole reader.
      const helper = spawn(descriptorSender, [], { stdio: ["pipe", "ignore", "pipe", "ignore", server, client] });
      helpers.add(helper);
      let detail = "";
      helper.stderr.on("data", data => { detail = (detail + data).slice(-4096); });
      // A transport error does not confirm native exit. Its cleanup owner
      // keeps the child until an actual exit or bounded retirement.
      helper.once("error", error => { reject(error); });
      helper.once("exit", (code, term) => {
        helpers.delete(helper);
        if (code === 0) resolve();
        else reject(Error("Android descriptor transfer failed (" + (term || code) + "): " + detail.trim()));
      });
      helper.stdin.on("error", () => {});
      helper.stdin.end(Buffer.concat([
        frame({ op: "connect", peer: fromIdentity, server: true, connectionId }),
        frame({ op: "connect", peer: destination.identity, server: false, connectionId })
      ]));
    }));
  }
  function retireRoute(id,route){
    if(route.retiring)return route.retiring;
    route.cancelled=true;
    return route.retiring=(async()=>{
      try{await route.ready.catch(()=>{});if(route.profile)await route.release();}
      finally{if(routes.get(id)===route)routes.delete(id);}
    })();
  }
  async function profileDemand(from,identity,request,message){
    const id="profile:"+from.pid+":"+request.role;
    let route=routes.get(id);
    if(route?.cancelled)await route.retiring;
    route=routes.get(id);
    if(!route){
      route={from,fromIdentity:identity,profile:request,connectionId:randomUUID(),cancelled:false};
      routes.set(id,route);
      let owner,enrolled=false,releasing;
      route.release=()=>releasing??=(async()=>{try{if(enrolled)await owner.retire(identity);}finally{await owner?.close();}})();
      route.ready=(async()=>{
        try{
          owner=await require("./platform-services/client").acquire({...request.options,signal,logger});route.owner=owner;
          initializing(from);if(route.cancelled)throw Error("Android process demand was retired.");
          await owner.enroll(identity,request.role==="accounts"?{packages,account:accountOptions?.account||null,networkAllowed:accountOptions?.networkAllowed===true}:request.role==="system"?{packages}:undefined);
          enrolled=true;route.toIdentity=owner.identity;
          initializing(from);if(route.cancelled)throw Error("Android process demand was retired.");
          await send(from,{op:"connect",role:request.role,peer:owner.identity,socketPath:owner.socketPath,connectionId:route.connectionId});
        }catch(error){
          if(!closed&&live(from))logger?.warn?.("[android] Profile service startup failed: "+JSON.stringify({role:request.role,...require("./account-stages").lifecycleFailure(error,"acquire-profile-service")}));
          try{await route.release();}catch(cleanup){logger?.warn?.("[android] Service retirement: "+cleanup.message);}
          if(routes.get(id)===route)routes.delete(id);throw error;
        }
      })();
    }
    try{await route.ready;}
    catch(error){
      if(!closed&&live(from))await send(from,{op:"unavailable",packageName:request.packageName,processName:request.processName,...(message.requestId?{requestId:message.requestId}:{}),reason:error.message});
    }
  }
  function watch(child, identity, slot, presentation = child, presentationIdentity = identity) {
    // A native VM can present through its supervisor-owned window process.
    // Only this local ChildProcess relation selects the shortcut observer;
    // no guest message can nominate another process or create a gesture.
    const clipboardPid = presentationIdentity.hostPid;
    clipboardOwner?.enroll(clipboardPid);
    const retireClipboard = () => {
      clipboardOwner?.retire(clipboardPid);
      clipboard.get(child)?.abort(); clipboard.delete(child);
    };
    if (presentation !== child) presentation.once("exit", retireClipboard);
    const stream = child.stdio[5];
    let lifecyclePending,lifecycleSending=false,lifecycleOwner;
    async function lifecycle(){
      if(lifecycleSending)return;lifecycleSending=true;
      try{while(!closed&&live(child)&&lifecyclePending!==undefined){
        const state=lifecyclePending;lifecyclePending=undefined;await lifecycleOwner.processState(identity,state);
      }}catch(error){if(!closed&&live(child))logger?.warn?.("[android] Process lifecycle: "+error.message);}
      finally{lifecycleSending=false;}
    }
    receive(stream, message => {
      if(message.op==="process-state"){
        const owner=system||[...routes.values()].find(route=>route.from===child&&route.profile?.role==="system"&&!route.cancelled)?.owner;
        if(owner?.identity?.processStateVersion!==1||!Number.isInteger(message.state)||message.state<0||message.state>=20)
          throw Error("Invalid Android process lifecycle message.");
        if(!closed&&live(child)){lifecycleOwner=owner;lifecyclePending=message.state;void lifecycle();}
        return;
      }
      if (message.op === "operation-result") {
        if (child !== gameChild || !config.serviceOperation || message.id !== config.operationId ||
            !["licensed", "not-licensed", "unavailable", "failure", "timeout"].includes(message.status) ||
            !Number.isSafeInteger(message.code) || message.code < -1 || message.code > 2147483647)
          throw Error("Invalid Android operation result.");
        child.emit("androidOperationResult", { status: message.status, code: message.code });
        return;
      }
      if (message.op === "clipboard") {
        if (typeof message.requestId !== "string" || !/^[1-9][0-9]{0,19}$/.test(message.requestId))
          throw Error("Invalid Android clipboard request identity.");
        const reply = result => {
          if (!closed && live(child)) return send(child, { op: "clipboard", requestId: message.requestId, ...result }).catch(() => {});
        };
        if (clipboard.has(child) || closed || !live(child) || !live(presentation)) { void reply({ allowed: false }); return; }
        const controller = new AbortController(); clipboard.set(child, controller);
        void Promise.resolve().then(() => clipboardOwner?.transfer(clipboardPid, message.operation, message.text,
          { signal: controller.signal }) ?? { allowed: false }).catch(() => ({ allowed: false })).then(reply)
          .finally(() => { if (clipboard.get(child) === controller) clipboard.delete(child); });
        return;
      }
      if (message.op === "window-close") {
        child.stopRequested = true;
        child.emit("stopRequested");
        return;
      }
      if (message.op === "disconnect") {
        const peer = message.peer;
        if (!peer || !Number.isSafeInteger(peer.pid) || typeof message.connectionId !== "string")
          throw Error("Invalid Android connection retirement.");
        const found=[...routes].find(([,route])=>route.connectionId===message.connectionId&&route.from===child||route.connectionId===message.connectionId&&route.to===child);
        const [id,route]=found||[];
        // The inherited channel identifies the sender. The generation protects
        // a replacement session from delayed death of its predecessor.
        if (!route || route.connectionId !== message.connectionId) return;
        const other = route.from === child ? route.to : route.to === child ? route.from : null;
        const expected = route.from === child ? route.toIdentity : route.fromIdentity;
        if (!expected || peer.pid !== expected.pid || peer.uid !== expected.uid ||
          peer.packageName !== expected.packageName || peer.processName !== expected.processName)
          throw Error("Android connection retirement differs from its authenticated peer.");
        void retireRoute(id,route).catch(error=>logger?.warn?.("[android] Service retirement: "+error.message));
        if (!closed && live(other)) void send(other, { op: "unavailable", peer: identity,
          connectionId: route.connectionId }).catch(() => {});
        return;
      }
      if (message.op !== "connect" || typeof message.packageName !== "string" || typeof message.processName !== "string" ||
        (message.requestId != null && typeof message.requestId !== "string"))
        throw Error("Invalid Android process request.");
      void demand(child, identity, message).catch(error => logger?.warn?.("[android] Process demand: " + error.message));
    }, error => {
      if (!closed) logger?.warn?.("[android] Service authority: " + error.message);
      stream.destroy();
    });
    child.once("exit", () => {
      retireClipboard();
      if (presentation !== child) presentation.removeListener("exit", retireClipboard);
      stopping.delete(child);
      for (const [id, route] of routes) if (route.from === child || route.to === child) {
        void retireRoute(id,route).catch(error=>logger?.warn?.("[android] Service retirement: "+error.message));
        const other = route.from === child ? route.to : route.from;
        if (!closed && live(other)) void send(other, { op: "unavailable", peer: identity }).catch(() => {});
      }
    });
  }
  async function start(slot) {
    if (slot.starting) return slot.starting;
    if (live(slot.child)) return slot;
    let stage = "launch";
    slot.starting = (async () => {
      signal?.throwIfAborted();
      if (closed) throw Error("Android service startup was cancelled.");
      const service = slot.service;
      const fields = { installedPackagesJson: config.installedPackagesJson, serviceProcess: 1, authorityFd: 5,
        processName: service.record.processName };
      if (config.googleProviderCompatibility != null) fields.googleProviderCompatibility = config.googleProviderCompatibility;
      const child = await launchService(service, fields, ["ignore", "ignore", "pipe", "ignore", "ignore", "pipe"], sandbox);
      children.add(child); slot.child = child;
      child.once("exit", () => {children.delete(child);if(service.release)Promise.resolve(service.release()).catch(()=>{});});
      if (!live(child)) children.delete(child);
      if (closed) { await stop(child); throw Error("Android service startup was cancelled."); }
      stage = "process-identity";
      slot.identity = await processIdentity(child, service.record.packageName, service.record.processName, service.record.uid, processIdentityVersion);
      watch(child, slot.identity,slot);
      await initialize(child,slot.identity,slot,value=>{stage=value;});
      return slot;
    })();
    try { return await slot.starting; }
    catch(error){
      // Preserve the first structural cause before closing the inherited
      // descriptor. The peer's later EOF cannot identify a failed enrollment;
      // exception text can contain application/account values and is omitted.
      logger?.warn?.("[android] Process startup failed: "+JSON.stringify(require("./account-stages").lifecycleFailure(error,stage)));
      if(slot.child)await stop(slot.child);slot.child=null;slot.identity=null;throw error;
    }
    finally { slot.starting = null; }
  }
  async function demand(from, fromIdentity, message) {
    if (closed || !live(from)) return;
    logger?.debug?.("[android] Process request: " + fromIdentity.processName + " → " + message.processName);
    let destination, route;
    const target = slots.get(key(message.packageName, message.processName)) ||
      (packages.some(item=>item.packageName===message.packageName&&item.uid===installed.uid)&&message.processName === gameProcess && gameChild ? { child: gameChild, identity: gameIdentity } : null);
    if(target?.profile)return profileDemand(from,fromIdentity,target.profile,message);
    try {
      if (!target) throw Error("The requested Android process is not installed.");
      destination = target;
      if (destination.starting || !live(destination.child)) destination=await start(target);
      if (closed || !live(from) || destination.child === from) return;
      const id = [from.pid, destination.child.pid].sort((a, b) => a - b).join(":");
      route = routes.get(id);
      if (!route) {
        route = { from, fromIdentity, to: destination.child, toIdentity: destination.identity,
          connectionId: randomUUID() }; routes.set(id, route);
        route.ready = connectPair(from, fromIdentity, destination, route.connectionId).catch(async error => {
          if (routes.get(id) === route) routes.delete(id);
          if (!closed && live(destination.child)) await send(destination.child, { op: "unavailable", peer: fromIdentity,
            connectionId: route.connectionId }).catch(() => {});
          throw error;
        });
      }
      await route.ready;
    } catch (error) {
      if (!closed && live(from)) {
        if (destination?.identity) await send(from, { op: "unavailable", peer: destination.identity,
          ...(route ? { connectionId: route.connectionId } : {}), reason: error.message });
        // A transfer may fail before either side adopts the pending demand.
        // Request identity keeps its failure separate from a subsequent retry.
        if (message.requestId || !destination?.identity) await send(from, { op: "unavailable", packageName: message.packageName,
          processName: message.processName, ...(message.requestId ? { requestId: message.requestId } : {}), reason: error.message });
      }
    }
  }
  const exited = () => { void close().catch(error => logger?.warn?.("[android] Service cleanup: " + error.message)); };
  function close() {
    if (closing) return closing;
    closed = true; signal?.removeEventListener("abort", exited);
    let clipboardClosed;
    // An error event is not an exit observation. Keep every acquired consumer
    // here even if a transport removes it from its normal pending-work set.
    for(const child of [gameChild,...children,...helpers].filter(Boolean))consumers.add(child);
    closing = Promise.resolve().then(()=>retireAll([
      ()=>retireAll([...clipboard.values()].map(operation=>()=>operation.abort())),
      ()=>{clipboard.clear();clipboardClosed=clipboardOwner?.close();clipboardClosed?.catch?.(()=>{});},
      ()=>{gameChild?.removeListener("exit", exited);gameChild?.removeListener("close", exited);gameChild?.stdio?.[5]?.end();},
      ()=>stopProcesses(helpers,{group:false}),
      async()=>{
      // Acquisition can finish after cancellation. Keep its leases inside this
      // supervisor's retirement before releasing package generations.
      if(acquiring)await acquiring.catch(()=>{});
      // Main-process initialization owns these same leases until its current
      // registration finishes. Cancellation must not close accounts beneath
      // a still-running system enrollment and then resume into that dead lease.
      if(connecting)await connecting.catch(()=>{});
      await Promise.allSettled([...slots.values()].map(slot => slot.starting).filter(Boolean));
      for(const child of [gameChild,...children,...helpers].filter(Boolean))consumers.add(child);
      },
      async()=>{const results=await Promise.allSettled([...new Set([gameChild,...children])].filter(Boolean).map(stop));const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;},
      ()=>clipboardClosed,
      ()=>retireAll([...routes].map(([id,route])=>()=>retireRoute(id,route))),
      async()=>{
        requireRetired(consumers);routes.clear();
        await retireAll([
          ...[platform,system,accounts].filter(owner=>owner&&!borrowedOwners.has(owner)).map(owner=>()=>owner.close()),
          ()=>profileReservation?.close(),()=>installed.release()
        ]);
      }
    ])); return closing;
  }
  signal?.addEventListener("abort", exited, { once: true });
  try {
    signal?.throwIfAborted();
    // The private endpoint locations belong to the profile, independent of
    // owner readiness. Grant those exact paths while the game JVM initializes;
    // no service process starts until an actual directory request arrives.
    acquiring=reserveProfileOwners({platformOptions,accountOptions,platformOwners,signal},profileReservation).then(value=>{profileReservation=value;});
    await acquiring;acquiring=null;signal?.throwIfAborted();if(closed)throw Error("Android service startup was cancelled.");
    const locations=await Promise.all(requestedProfiles.map(request=>require("./platform-services/paths").paths(request.options.userDataDir,request.options.role,request.options)));
    // Device metadata is available before any app/provider construction, even
    // when no profile service has been requested. Its owner keeps the host boot
    // identity private and serializes concurrent launch supervisors itself.
    const profileDirectory=userDataDir??platformOptions?.userDataDir??accountOptions?.userDataDir;
    if(profileDirectory){
      const systemLocation=locations[requestedProfiles.findIndex(request=>request.role==="system")]??await require("./platform-services/paths").paths(profileDirectory,"system");
      bootCount=await require("./platform-services/boot-state").bootCount(systemLocation);
    }
    const sockets=[...locations.map(storage=>storage.platformSocket),...Object.values(platformOwners||{}).map(owner=>owner.socketPath).filter(Boolean)];
    if(sockets.length)sandbox.localSockets={connect:sockets};
    // Older immutable Java payloads only accept bootstrap endpoints. Retain
    // their published protocol until a payload declares late service demand.
    if(!lazyProfiles)acquiring=Promise.allSettled(requestedProfiles.map(async request=>{
      const owner=await require("./platform-services/client").acquire({...request.options,signal,logger});
      if(request.role==="keystore")platform=owner;else if(request.role==="system")system=owner;else accounts=owner;
      return owner;
    }));
    return { sandbox,
      stdio(base) { const streams = [...base]; while (streams.length < 6) streams.push("ignore"); streams[5] = "pipe"; return streams; },
      async connect(child, { presentation = child } = {}) {
        const operation=(async()=>{
        signal?.throwIfAborted(); if (closed) throw Error("Android service startup was cancelled.");
        gameChild = child; child.once("exit", exited); child.once("close", exited);
        if(acquiring){const owners=await acquiring,failed=owners.find(result=>result.status==="rejected");if(failed)throw failed.reason;}
        signal?.throwIfAborted();if(closed)throw Error("Android service startup was cancelled.");
        gameIdentity = await processIdentity(child, config.packageName, gameProcess, installed.uid, processIdentityVersion);
        initializing(child);
        // The separate presenter is a physical Mac window/clipboard owner;
        // it is not enrolled as another Android application principal.
        const presenterIdentity = presentation === child ? gameIdentity : { hostPid: presentation.pid };
        if (!Number.isSafeInteger(presenterIdentity.hostPid) || presenterIdentity.hostPid < 2 || !live(presentation)) throw Error("The Android presentation process exited during registration.");
        watch(child, gameIdentity, undefined, presentation, presenterIdentity); await initialize(child, gameIdentity);return gameIdentity;
        })();
        connecting=operation;
        try{return await operation;}finally{if(connecting===operation)connecting=null;}
      }, close, requireRetired:()=>requireRetired(new Set([...consumers,gameChild,...children,...helpers].filter(Boolean))) };
  } catch (error) { try{await close();}catch(cleanup){logger?.warn?.('[android] Service cleanup: '+cleanup.message);}throw error; }
}
module.exports = { prepareConnections, reserveProfileOwners };
