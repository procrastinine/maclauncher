const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const B = require("../shared/runtime/bundled-native"), HG = require("./image-hg3"), Helper = require("./runtime/viewport-v2-helper");
const LIMITS = Object.freeze({ lineBytes: 1024 * 1024, eventBytes: 16384, layers: 256, sceneBytes: 256 * 1024 * 1024 });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const environment = () => ({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", HOME: os.homedir() });

function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function scalar(value, min, max) { return Number.isFinite(value) && value >= min && value <= max; }
function text(value, maximum) { return typeof value === "string" && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value); }
async function cacheDirectory(cacheRoot) {
  if (!path.isAbsolute(cacheRoot || "")) throw new Error("Choose an absolute per-game graphics cache directory.");
  B.realDirectory(cacheRoot, {create:true});
  return fs.promises.realpath(cacheRoot);
}
function confined(root, file) {
  if (!text(file,4096) || !file) throw new Error("Invalid viewport image path.");
  const relative = path.isAbsolute(file) ? path.relative(root,file) : file;
  if (relative.includes("\\") || relative.split("/").some(part=>!part || part==="." || part==="..") || path.isAbsolute(relative))
    throw new Error("Viewport images must stay inside their per-game cache.");
  return path.join(root,relative);
}
async function regularBytes(file, expected) {
  const before = await fs.promises.lstat(file,{bigint:true});
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(expected)) throw new Error("Viewport cache image changed or is not a regular file.");
  const handle = await fs.promises.open(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (identity(await handle.stat({bigint:true})) !== identity(before)) throw new Error("Viewport cache image changed during opening.");
    const bytes = await handle.readFile();
    if (bytes.length !== expected || identity(await handle.stat({bigint:true})) !== identity(before) || identity(await fs.promises.lstat(file,{bigint:true})) !== identity(before))
      throw new Error("Viewport cache image changed during reading.");
    return bytes;
  } finally {await handle.close();}
}

async function writeFrame(cacheRoot, frame, {signal}={}) {
  signal?.throwIfAborted();
  if (!frame || !integer(frame.width,1,HG.LIMITS.dimension) || !integer(frame.height,1,HG.LIMITS.dimension) || frame.width*frame.height > HG.LIMITS.pixels ||
      !integer(frame.frameId,0,0xffffffff) || !integer(frame.frameIndex,0,HG.LIMITS.frames-1) || ![24,32].includes(frame.bpp) ||
      !integer(frame.canvasWidth,1,HG.LIMITS.dimension) || !integer(frame.canvasHeight,1,HG.LIMITS.dimension) || frame.canvasWidth*frame.canvasHeight > HG.LIMITS.pixels ||
      !integer(frame.offsetX,-HG.LIMITS.dimension,HG.LIMITS.dimension) || !integer(frame.offsetY,-HG.LIMITS.dimension,HG.LIMITS.dimension) ||
      !Buffer.isBuffer(frame.rgba) || frame.rgba.length !== frame.width*frame.height*4 || frame.decoderVersion !== HG.VERSION)
    throw new Error("Choose a bounded decoded HG-3 frame.");
  const root = await cacheDirectory(cacheRoot), frames = path.join(root,"frames"); B.realDirectory(frames,{create:true});
  const metadata = {frameId:frame.frameId,frameIndex:frame.frameIndex,width:frame.width,height:frame.height,canvasWidth:frame.canvasWidth,canvasHeight:frame.canvasHeight,
    offsetX:frame.offsetX,offsetY:frame.offsetY,bpp:frame.bpp,decoderVersion:frame.decoderVersion};
  const rgbaSha256 = digest(frame.rgba), key = digest(Buffer.from(JSON.stringify({...metadata,rgbaSha256}))), target = path.join(frames,key+".rgba");
  async function existing() {
    if (digest(await regularBytes(target,frame.rgba.length)) !== rgbaSha256) throw new Error("The decoded graphics cache was modified.");
  }
  try { await existing(); return Object.freeze({...metadata,rgbaPath:target,rgbaSha256,key,reused:true}); }
  catch(error) { if(error.code!=="ENOENT")throw error; }
  const temporary=path.join(frames,".partial-"+crypto.randomUUID()); let handle;
  try {
    handle=await fs.promises.open(temporary,"wx",0o600); await handle.writeFile(frame.rgba); await handle.sync(); await handle.close(); handle=null;
    signal?.throwIfAborted();
    try {await fs.promises.link(temporary,target);} catch(error) {if(error.code!=="EEXIST")throw error;}
    await existing(); signal?.throwIfAborted(); return Object.freeze({...metadata,rgbaPath:target,rgbaSha256,key,reused:false});
  } finally {await handle?.close(); await fs.promises.rm(temporary,{force:true});}
}

function validateScene(scene, cacheRoot) {
  if (!scene || !integer(scene.sequence,0,Number.MAX_SAFE_INTEGER) || !scene.canvas || !integer(scene.canvas.width,1,HG.LIMITS.dimension) ||
      !integer(scene.canvas.height,1,HG.LIMITS.dimension) || scene.canvas.width*scene.canvas.height > HG.LIMITS.pixels ||
      (scene.canvas.title!==undefined && !text(scene.canvas.title,256)) || !Array.isArray(scene.layers) || scene.layers.length > LIMITS.layers)
    throw new Error("Invalid bounded viewport scene.");
  const ids = new Set(); let bytes = 0;
  const layers=scene.layers.map(layer=>{
    if(!layer || !text(layer.id,128) || !layer.id || ids.has(layer.id) || !integer(layer.width,1,HG.LIMITS.dimension) || !integer(layer.height,1,HG.LIMITS.dimension) ||
       layer.width*layer.height > HG.LIMITS.pixels || !scalar(layer.x,-32768,32768) || !scalar(layer.y,-32768,32768) || !scalar(layer.z,-1000000000,1000000000) ||
       !scalar(layer.opacity,0,1) || typeof layer.visible!=="boolean" || (layer.frameId!==undefined && !integer(layer.frameId,0,0xffffffff)))
      throw new Error("Invalid viewport layer.");
    ids.add(layer.id); bytes+=layer.width*layer.height*4; if(bytes>LIMITS.sceneBytes)throw new Error("Viewport images exceed their limit.");
    return {id:layer.id,rgbaPath:confined(cacheRoot,layer.rgbaPath),width:layer.width,height:layer.height,x:layer.x,y:layer.y,z:layer.z,
      opacity:layer.opacity,visible:layer.visible,...(layer.frameId===undefined?{}:{frameId:layer.frameId})};
  });
  const result={type:"scene",sequence:scene.sequence,canvas:{width:scene.canvas.width,height:scene.canvas.height,...(scene.canvas.title===undefined?{}:{title:scene.canvas.title})},layers};
  if(Buffer.byteLength(JSON.stringify(result))>LIMITS.lineBytes)throw new Error("Viewport scene message exceeds its limit.");
  return result;
}
function validateEvent(event) {
  if(!event || typeof event!=="object" || Array.isArray(event))throw new Error("Invalid native viewport event.");
  const valid = event.type==="ready" ? event.protocolVersion===2 && event.version===Helper.VERSION :
    event.type==="cursor-set" ? integer(event.sequence,0,Number.MAX_SAFE_INTEGER) :
    event.type==="presented" ? integer(event.sequence,0,Number.MAX_SAFE_INTEGER) && integer(event.layers,0,LIMITS.layers) :
    event.type==="pointer" ? ["move","down","up"].includes(event.kind) && scalar(event.x,0,HG.LIMITS.dimension) && scalar(event.y,0,HG.LIMITS.dimension) &&
      [0,1,2].includes(event.button) && integer(event.sequence,0,Number.MAX_SAFE_INTEGER) :
    event.type==="key" ? ["down","up"].includes(event.kind) && text(event.key,16) && !!event.key && typeof event.repeat==="boolean" :
    event.type==="close" ? true : event.type==="error" ? text(event.message,256) : false;
  if(!valid)throw new Error("Native viewport protocol or event bounds differ."); return event;
}
function validateCursor(cursor, cacheRoot, sequence) {
  if (!cursor || !integer(sequence,0,Number.MAX_SAFE_INTEGER)) throw new Error("Invalid bounded viewport cursor.");
  if (cursor.kind === "system" && ["arrow","pointingHand","IBeam","crosshair"].includes(cursor.name))
    return {type:"cursor",sequence,cursor:{kind:"system",name:cursor.name}};
  if (cursor.kind !== "image" || !integer(cursor.width,1,256) || !integer(cursor.height,1,256) ||
      !integer(cursor.hotspotX,0,cursor.width-1) || !integer(cursor.hotspotY,0,cursor.height-1)) throw new Error("Invalid viewport cursor image or hotspot.");
  return {type:"cursor",sequence,cursor:{kind:"image",rgbaPath:confined(cacheRoot,cursor.rgbaPath),width:cursor.width,height:cursor.height,hotspotX:cursor.hotspotX,hotspotY:cursor.hotspotY}};
}

async function openViewport({cacheRoot,helper,signal,onEvent,spawnChild=spawn,resourcesRoot,helperDependencies}={}) {
  signal?.throwIfAborted();
  const root=await cacheDirectory(cacheRoot), selected=helper||await Helper.resolveHelper({resourcesRoot,dependencies:helperDependencies});
  if(selected.version!==Helper.VERSION || selected.protocolVersion!==2 || !path.isAbsolute(selected.executablePath||""))throw new Error("The selected software viewport version is incompatible.");
  const child=spawnChild(selected.executablePath,["--cache-root",root],{stdio:["pipe","pipe","pipe"],env:environment(),...(signal?{signal}:{})});
  const decoder=new StringDecoder("utf8");
  const cursorRequests=new Map();
  let buffer="", ready=false, ended=false, sequence=-1, cursorSequence=-1, serial=Promise.resolve(), readyResolve, readyReject, closeResolve;
  const readiness=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;}), closed=new Promise(resolve=>{closeResolve=resolve;});
  function publish(event) {try {const result=onEvent?.(event); result?.catch?.(()=>{});}catch{} }
  function cursorResult(sequence,error) {
    const request=cursorRequests.get(sequence);if(!request)return false;
    clearTimeout(request.timer);cursorRequests.delete(sequence);error?request.reject(error):request.resolve(sequence);return true;
  }
  function fail(error) {if(!ready)readyReject(error); else publish({type:"error",message:error.message}); child.kill("SIGTERM");}
  const timer=setTimeout(()=>fail(new Error("The native viewport did not become ready.")),10000);
  child.on("error",()=>fail(new Error("The native viewport could not start.")));
  child.stdin.on("error",()=>{if(!ended)fail(new Error("The native viewport input was interrupted."));});
  child.stderr.resume();
  child.stdout.on("data",chunk=>{
    buffer+=decoder.write(chunk);
    if(Buffer.byteLength(buffer)>LIMITS.eventBytes*2){fail(new Error("Native viewport output exceeds its limit."));return;}
    let end;
    while((end=buffer.indexOf("\n"))>=0) {
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      try {if(Buffer.byteLength(line)>LIMITS.eventBytes)throw new Error("Native viewport event exceeds its limit."); const event=validateEvent(JSON.parse(line));
        if(event.type==="ready"){if(ready)throw new Error("Duplicate native viewport ready event.");ready=true;clearTimeout(timer);readyResolve();}
        if(event.type==="cursor-set"&&!cursorResult(event.sequence))throw new Error("Native viewport cursor confirmation is unexpected.");
        if(event.type==="error")fail(new Error(event.message)); else publish(event);
      } catch(error){fail(error);}
    }
  });
  child.on("close",(code,exitSignal)=>{ended=true;clearTimeout(timer);for(const sequence of cursorRequests.keys())cursorResult(sequence,new Error("The native viewport closed before applying its cursor."));
    if(!ready)readyReject(new Error("The native viewport exited before becoming ready."));closeResolve({code,signal:exitSignal});});
  async function sendScene(scene) {
    const operation=serial.then(async()=>{
      if(ended)throw new Error("The native viewport is closed.");signal?.throwIfAborted();
      const next=scene.sequence===undefined?sequence+1:scene.sequence, message=validateScene({...scene,sequence:next},root);
      if(next<=sequence)throw new Error("Viewport scene sequence must increase.");
      await new Promise((resolve,reject)=>child.stdin.write(JSON.stringify(message)+"\n",error=>error?reject(error):resolve()));sequence=next;return next;
    }); serial=operation.catch(()=>{}); return operation;
  }
  async function close() {
    if(ended)return closed;
    child.stdin.end('{"type":"close"}\n');
    const term=setTimeout(()=>child.kill("SIGTERM"),2000), kill=setTimeout(()=>child.kill("SIGKILL"),4000);
    try{return await closed;}finally{clearTimeout(term);clearTimeout(kill);}
  }
  async function setCursor(cursor) {
    const operation=serial.then(async()=>{
      if(ended)throw new Error("The native viewport is closed.");signal?.throwIfAborted();
      const next=cursorSequence+1,message=validateCursor(cursor,root,next);
      cursorSequence=next;
      return new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>{const error=new Error("The native viewport did not apply its cursor.");cursorResult(next,error);fail(error);},5000);
        cursorRequests.set(next,{resolve,reject,timer:timeout});
        child.stdin.write(JSON.stringify(message)+"\n",error=>{if(error)cursorResult(next,error);});
      });
    });serial=operation.catch(()=>{});return operation;
  }
  try {await readiness;}catch(error){await close();throw error;}
  return Object.freeze({child,pid:child.pid,helper:selected,cacheRoot:root,sendScene,setCursor,close,closed});
}

async function decodeRaster(bytes,{cacheRoot,helper,width,height,encoding,signal,spawnChild=spawn,resourcesRoot,helperDependencies}={}) {
  signal?.throwIfAborted();
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>HG.LIMITS.inputBytes||!["jpeg","webp"].includes(encoding)||
     !integer(width,1,HG.LIMITS.dimension)||!integer(height,1,HG.LIMITS.dimension)||width*height>HG.LIMITS.pixels)throw new Error("Invalid bounded HG-3 raster request.");
  const root=await cacheDirectory(cacheRoot), selected=helper||await Helper.resolveHelper({resourcesRoot,dependencies:helperDependencies});
  if(selected.version!==Helper.VERSION||selected.protocolVersion!==2)throw new Error("The selected raster helper version is incompatible.");
  const directory=path.join(root,"raster");B.realDirectory(directory,{create:true});const key=crypto.randomUUID(),input=path.join(directory,key+".image"),output=path.join(directory,key+".rgba");
  try {
    await fs.promises.writeFile(input,bytes,{flag:"wx",mode:0o600});signal?.throwIfAborted();
    await new Promise((resolve,reject)=>{
      const child=spawnChild(selected.executablePath,["--cache-root",root,"--decode-raster",input,"--output",output,"--encoding",encoding,"--width",String(width),"--height",String(height)],
        {stdio:["ignore","pipe","pipe"],env:environment(),...(signal?{signal}:{})});
      let settled=false,size=0,errorText="",failure=null,kill;
      function stop(error,force=false){failure||=error;child.kill(force?"SIGKILL":"SIGTERM");if(!force&&!kill)kill=setTimeout(()=>child.kill("SIGKILL"),1000);}
      const timer=setTimeout(()=>stop(new Error("HG-3 raster decoding timed out."),true),15000);
      function finish(error){if(settled)return;settled=true;clearTimeout(timer);clearTimeout(kill);error?reject(error):resolve();}
      child.stderr.resume();child.stdout.on("data",chunk=>{size+=chunk.length;if(size>LIMITS.eventBytes)stop(new Error("HG-3 raster output exceeds its limit."));else errorText+=chunk.toString("utf8");});
      child.on("error",()=>{failure||=new Error("HG-3 raster decoding could not start.");});
      // Reap the child before removing its files, including aborted requests.
      child.on("close",code=>{
        if(failure)return finish(failure);
        let event;try{event=JSON.parse(errorText);}catch{}
        if(code===0&&event?.type==="decoded"&&event.width===width&&event.height===height&&event.bytes===width*height*4)return finish();
        const message=event?.type==="error"&&text(event.message,256)?event.message:"HG-3 raster output or dimensions disagree.";finish(new Error(message));
      });
    });
    signal?.throwIfAborted();return await regularBytes(output,width*height*4);
  } finally {await fs.promises.rm(input,{force:true});await fs.promises.rm(output,{force:true});}
}
module.exports={LIMITS,writeFrame,validateScene,validateCursor,validateEvent,openViewport,decodeRaster};
