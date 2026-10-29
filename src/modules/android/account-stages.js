// Provider output may contain credentials. Retain fixed stage counters and
// validated Java exception identities/stack sites, never provider messages.
const stages = {
  webClosed: "JSBridge: closeView",
  deviceCheckStarted: "getDroidGuardResult start",
  deviceCheckFinished: "getDroidGuardResult end",
  httpRequested: "-- Request --",
  httpResponded: "-- Response --",
  accountRejected: "Account NOT created!",
  callbackException: "onException",
  socketTimeout: "java.net.SocketTimeoutException",
  tlsError: "javax.net.ssl.SSLHandshakeException",
  permissionError: "java.lang.SecurityException"
};
const lifecycleCodes = new Set([...Object.keys(require("node:os").constants.errno),
  "ABORT_ERR", "ACCOUNT_OWNER_UNAVAILABLE", "ACCOUNT_JAVA_UNAVAILABLE", "ACCOUNT_PROVIDER_MISSING",
  "ACCOUNT_RUNTIME_UNAVAILABLE", "ACCOUNT_LEASE_RELEASED", "ACCOUNT_PROVIDER_ERROR",
  "ACCOUNT_CONTROL_PROTOCOL", "ACCOUNT_CONTROL_IO", "ACCOUNT_CONTROL_EOF", "ACCOUNT_OWNER_EXITED",
  "ACCOUNT_CONTROL_CLOSED", "ANDROID_APK_SOURCE_MISSING"]);
function providerFailureDetails(error) {
  const result = {};
  try {
    for (const name of ["providerFailureType", "failureType"]) {
      const value = error?.[name];
      if (typeof value === "string" && value.length <= 256 && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){1,30}$/.test(value)) {
        result.providerFailureType = value; break;
      }
    }
    const site = error?.providerFailureSite;
    if (typeof site === "string" && site.length <= 384 && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){1,30}:-?\d{1,7}$/.test(site)) result.providerFailureSite = site;
  } catch { /* Diagnostic inspection cannot replace the original failure. */ }
  return result;
}
/** Only code identities and an owner-supplied phase leave the failure boundary.
 * Error messages, stacks, names and provider values can contain account data. */
function lifecycleFailure(error, stage) {
  let type = "Error", sites = [], code;
  try {
    if (typeof error?.platformStartupStage === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(error.platformStartupStage))
      stage = error.platformStartupStage;
    if (typeof error?.code === "string" && lifecycleCodes.has(error.code)) code = error.code;
    for (const original of [TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError, AggregateError])
      if (error instanceof original) { type = original.name; break; }
    const provider = providerFailureDetails(error);
    if (provider.providerFailureType) type = provider.providerFailureType;
    if (provider.providerFailureSite) sites = [provider.providerFailureSite];
  } catch { /* Diagnostic inspection cannot replace the original failure. */ }
  return { stage: typeof stage === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(stage) ? stage : "initialization",
    type, sites, causes: [], ...(code ? { code } : {}) };
}
function create() {
  let failure=null,trace=null,phase="lead",token="",prefix="",position=0,afterPrefix="",cause=false,explicit=false,authoritative=false;
  const reset=()=>{phase="lead";token="";prefix="";position=0;cause=false;explicit=false;};
  const fixed=(value,next)=>{prefix=value;position=0;afterPrefix=next;phase="prefix";};
  const exception=()=>{
    if(!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(token)||!/(?:Exception|Error)$/.test(token))return;
    const value={type:token,sites:[]};
    if(cause&&failure){if(failure.causes.length>=8){trace=null;return;}failure.causes.push(value);}
    else {
      // The account owner reports rejected commands before its cleanup emits
      // incidental Java warnings. Keep that first rejection and its frames.
      if(authoritative){trace=null;return;}
      failure={...value,causes:[]};authoritative=explicit;
    }
    trace=cause?value:failure;
  };
  const observe=byte=>{
    const character=String.fromCharCode(byte);
    if(character==="\n"){if(phase==="type"||phase==="lead")exception();reset();return;}
    if(phase==="discard"||character==="\r")return;
    if(phase==="prefix"){if(character!==prefix[position++]){phase="discard";return;}if(position===prefix.length){phase=afterPrefix;token="";}return;}
    if(phase==="thread"){if(character==='"')phase="type";return;}
    if(phase==="frame"){
      if(!/[A-Za-z0-9_.$/@<>(): -]/.test(character)||token.length>=384){phase="discard";token="";return;}
      token+=character;
      if(character===")"){
        const match=token.match(/^((?:[\w.$@-]+\/)*[\w.$]+\.[\w$<>]+)\((?:Native Method|Unknown Source|[\w.$-]+\.java(?::\d+)?)\)$/);
        if(match&&trace&&trace.sites.length<32)trace.sites.push(token);
        phase="discard";token="";
      }
      return;
    }
    if(!token&&(character===" "||character==="\t"))return;
    if(phase==="lead"&&!token&&character==="["){fixed("android-host] ","lead");return;}
    if(/[A-Za-z0-9_.$]/.test(character)&&token.length<256){token+=character;return;}
    if(phase==="lead"&&token==="Exception"&&character===" "){fixed('in thread "',"thread");return;}
    if(phase==="lead"&&token==="Account"&&character===" "){explicit=true;fixed("command failed: ","type");return;}
    if(phase==="lead"&&token==="Caused"&&character===" "){cause=true;fixed("by: ","type");return;}
    if(phase==="lead"&&token==="Suppressed"&&character===":"){cause=true;phase="type";token="";return;}
    if(phase==="lead"&&token==="at"&&character===" "){phase="frame";token="";return;}
    if(character===":"||character===" ")exception();
    phase="discard";token="";
  };
  const matchers = Object.entries(stages).map(([name, value]) => {
    const bytes = Buffer.from(value), prefix = new Uint16Array(bytes.length);
    for (let i = 1, matched = 0; i < bytes.length; i++) {
      while (matched && bytes[i] !== bytes[matched]) matched = prefix[matched - 1];
      if (bytes[i] === bytes[matched]) matched++;
      prefix[i] = matched;
    }
    return { name, bytes, prefix, matched: 0, count: 0 };
  });
  let latest = null, changedAt = null, operation = null;
  return {
    begin(kind) {
      if (kind !== "addAccount" && kind !== "removeAccount") return () => {};
      // A service can handle another command after a rejected one. Keep the
      // first failure within this operation without pinning the next command
      // to an earlier rejection from the same process.
      failure=trace=null;authoritative=false;reset();
      const current = operation = { kind, phase: "pending" };
      return success => { current.phase = success ? "complete" : "failed"; };
    },
    write(chunk) {
      for (const byte of Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) {
      observe(byte);
      for (const matcher of matchers) {
        while (matcher.matched && byte !== matcher.bytes[matcher.matched]) matcher.matched = matcher.prefix[matcher.matched - 1];
        if (byte === matcher.bytes[matcher.matched]) matcher.matched++;
        if (matcher.matched === matcher.bytes.length) {
          matcher.count = Math.min(Number.MAX_SAFE_INTEGER, matcher.count + 1);
          matcher.matched = matcher.prefix[matcher.matched - 1];
          latest = matcher.name; changedAt = Date.now();
        }
      }
      }
    },
    snapshot() { return { counters: Object.fromEntries(matchers.map(({ name, count }) => [name, count])), latest, changedAt, operation: operation && { ...operation },
      ...(failure?{failure:{...failure,sites:[...failure.sites],causes:failure.causes.map(value=>({...value,sites:[...value.sites]}))}}:{}) }; }
  };
}
const describeFailure=failure=>failure.type+(failure.sites[0]?" at "+failure.sites[0]:"");
module.exports = { create, describeFailure, lifecycleFailure, providerFailureDetails };
