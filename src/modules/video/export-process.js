const fs = require("node:fs"), path = require("node:path"), {spawn} = require("node:child_process");
const {TEMPORARY_PROCESS_MAX_GRACE_MS: SHUTDOWN_GRACE_MS} = require("../../core/process-stop");
const warn = require("../shared/graphics-warning");
function aborted(){const error = new Error("Video export was cancelled.");error.name = "AbortError";return error;}
function frameCounts(event) {
  const counts = {};
  for (const name of ["inputFrames", "generatedFrames", "repeatedFrames"]) {
    if (event[name] === undefined) continue;
    if (!Number.isSafeInteger(event[name]) || event[name] < 0 || event[name] > event.outputFrames)
      throw new Error("Invalid video export frame counts.");
    counts[name] = event[name];
  }
  if (Object.keys(counts).length === 3 && counts.inputFrames + counts.generatedFrames + counts.repeatedFrames !== event.outputFrames)
    throw new Error("Invalid video export frame counts.");
  return counts;
}
function qualityStatus(value) {
  if(value===undefined)return {};
  const scopes={unknown:"","source-and-processing":"Source + processing","image-processing":"Image processing","final-processing":"Final processing","offline-frame":"Offline frame","external-processing":"External processing"};
  if(!value||typeof value!=="object"||!['pending','active','off'].includes(value.state)||typeof value.nodeId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.nodeId)||value.nodeId.includes('..')||
    !Object.hasOwn(scopes,value.scope)||!Number.isFinite(value.scale)||value.scale<=0||value.scale>1||!Number.isFinite(value.meanMilliseconds)||value.meanMilliseconds<0||typeof value.reason!=="string"||value.reason.length>4096||
    value.state==='active'&&(value.scope==='unknown'||value.meanMilliseconds<=0))throw new Error("Invalid video adaptive-quality status.");
  const adaptiveQuality={nodeId:value.nodeId,state:value.state,scale:value.scale,meanMilliseconds:value.meanMilliseconds,scope:value.scope,reason:value.reason};
  return {adaptiveQuality,adaptiveQualitySummary:value.state==='active'?`${Math.round(value.scale*1000)/10}% · ${scopes[value.scope]} ${value.meanMilliseconds.toFixed(2)} ms`:value.state==='off'?'Off':'Timing pending'};
}
function outputColorStatus(value) {
  if(value===undefined)return {};
  const labels={auto:"Automatic",preserve:"None",reinhard:"Reinhard","pbr-neutral":"PBR Neutral"};
  if(!value||typeof value!=="object"||Array.isArray(value)||!Object.hasOwn(labels,value.requested)||!Object.hasOwn(labels,value.active)||
      typeof value.reason!=="string"||value.reason.length>4096||Object.keys(value).some(key=>!["requested","active","reason"].includes(key)))
    throw new Error("Invalid video output color status.");
  const outputColor={requested:value.requested,active:value.active,reason:value.reason};
  return {outputColor,outputColorSummary:value.requested===value.active?labels[value.active]:`${labels[value.active]} (requested ${labels[value.requested]})`};
}
function run({executable, args, env, output, signal, onProgress, onToolProcessSpawn, logger}) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    let child, pending = "", stderr = "", result, failure, cancelled = false, timer, settled = false, ownership = Promise.resolve();
    const stop = () => {child?.kill("SIGTERM");timer ||= setTimeout(() => child?.kill("SIGKILL"), SHUTDOWN_GRACE_MS);timer.unref?.();};
    const cancel = () => {if (!result) {cancelled = true;stop();}};
    const finish = (error, value) => {if(settled)return;settled = true;clearTimeout(timer);signal?.removeEventListener("abort", cancel);error ? reject(error) : resolve(value);};
    const line = text => {
      if (!text.trim()) return;
      try {
        const event = JSON.parse(text);
        if (event.type === "progress") {
          if (!Number.isFinite(event.fraction) || event.fraction < 0 || event.fraction > 1 ||
              !Number.isSafeInteger(event.outputFrames) || event.outputFrames < 0) throw new Error("Invalid export progress.");
          frameCounts(event);
          const quality=qualityStatus(event.adaptiveQuality),outputColor=outputColorStatus(event.outputColor);
          if (onProgress) {
            const failed = error => warn(logger, "Video export progress could not be reported.", error);
            try {
              const notification = onProgress({...event,...quality,...outputColor});
              if (notification && typeof notification.then === "function") Promise.resolve(notification).catch(failed);
            } catch (error) { failed(error); }
          }
        } else if (event.type === "complete") {
          if (typeof event.output !== "string" || path.resolve(event.output) !== output ||
              !Number.isSafeInteger(event.outputFrames) || event.outputFrames < 1) throw new Error("Invalid video export result.");
          const encoding = {};
          if (event.codec !== undefined || event.hdr !== undefined) {
            if (!["h264", "hevc-main10"].includes(event.codec) || typeof event.hdr !== "boolean" || event.hdr !== (event.codec === "hevc-main10"))
              throw new Error("Invalid video export encoding.");
            Object.assign(encoding, {codec: event.codec, hdr: event.hdr});
          }
          result = {output, outputFrames: event.outputFrames, ...frameCounts(event), ...qualityStatus(event.adaptiveQuality), ...outputColorStatus(event.outputColor), ...encoding,
            width: event.width, height: event.height, elapsedSeconds: event.elapsedSeconds};
        } else if (event.type === "cancelled") cancelled = true;
        else if (event.type === "error") failure = new Error(String(event.message || "Video export failed.").slice(0,4096));
      } catch(error){failure = error;stop();}
    };
    try {child = spawn(executable, args, {env, stdio: ["ignore", "pipe", "pipe"], shell: false});}
    catch(error){finish(error);return;}
    ownership = Promise.resolve().then(() => onToolProcessSpawn?.(child, {stopOnLauncherExit: true, shutdownGraceMs: SHUTDOWN_GRACE_MS})).catch(error => {failure = error;stop();});
    child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      pending += chunk;let index;
      while((index = pending.indexOf("\n")) !== -1) {
        if(index > 65536){failure = new Error("Video export progress exceeded its size limit.");pending = "";stop();return;}
        const next = pending.slice(0,index);pending = pending.slice(index+1);line(next);
      }
      if(pending.length > 65536){failure = new Error("Video export progress exceeded its size limit.");pending = "";stop();}
    });
    child.stderr.on("data", chunk => {stderr = (stderr+chunk).slice(-65536);});
    child.once("error", error => finish(error));
    child.once("close", async (code, exitSignal) => {
      await ownership;if(pending.trim())line(pending);
      if(cancelled&&!result){finish(aborted());return;}
      if(failure){finish(failure);return;}
      if(code!==0||exitSignal||!result){finish(new Error(stderr.trim().slice(-4096)||"Video export did not complete."));return;}
      try {if(!fs.statSync(output,{throwIfNoEntry:false})?.isFile())throw new Error("The exported video was not created.");}
      catch(error){finish(error);return;}
      finish(null,result);
    });
    signal?.addEventListener("abort",cancel,{once:true});if(signal?.aborted)cancel();
  });
}
module.exports = {run};
