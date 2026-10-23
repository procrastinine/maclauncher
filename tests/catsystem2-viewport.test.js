const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {EventEmitter}=require("node:events"),{PassThrough,Writable}=require("node:stream");
const View=require("../src/modules/catsystem2/viewport"),HG=require("../src/modules/catsystem2/image-hg3"),Helper=require("../src/modules/catsystem2/runtime/viewport-helper");
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),"maclauncher-cs-graphics-test-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function decoded(){return {frameId:7,frameIndex:0,width:1,height:1,canvasWidth:2,canvasHeight:2,offsetX:1,offsetY:0,bpp:32,decoderVersion:HG.VERSION,rgba:Buffer.from([255,0,0,127])};}
function scene(file){return {sequence:0,canvas:{width:2,height:2},layers:[{id:"button",rgbaPath:file,width:1,height:1,x:1,y:0,z:10,opacity:0.5,visible:true,frameId:7}]};}
test("decoded graphics cache reuses one content-addressed image and rejects modified data, symlinks and partial writes",async t=>{
  const root=temporary(t),before=decoded(),first=await View.writeFrame(root,before),second=await View.writeFrame(root,before);
  assert.equal(first.reused,false);assert.equal(second.reused,true);assert.equal(second.rgbaPath,first.rgbaPath);assert.equal(fs.readdirSync(path.join(root,"frames")).length,1);
  assert.deepEqual(fs.readFileSync(first.rgbaPath),before.rgba);assert.deepEqual(before,decoded());
  fs.writeFileSync(first.rgbaPath,Buffer.from([0,0,0,0]));await assert.rejects(()=>View.writeFrame(root,before),/modified/);
  fs.unlinkSync(first.rgbaPath);const outside=path.join(root,"other.rgba");fs.writeFileSync(outside,before.rgba);fs.symlinkSync(outside,first.rgbaPath);
  await assert.rejects(()=>View.writeFrame(root,before),/regular/);
  const abort=new AbortController();abort.abort();await assert.rejects(()=>View.writeFrame(root,before,{signal:abort.signal}),{name:"AbortError"});
  assert.ok(fs.readdirSync(path.join(root,"frames")).every(name=>!name.startsWith(".partial")));
});
test("viewport scenes preserve authored coordinates and reject escaping paths, invalid pixels and ambiguous layer IDs",t=>{
  const root=temporary(t),input=scene(path.join(root,"frames","sample.rgba")),result=View.validateScene(input,root);
  assert.equal(result.type,"scene");assert.equal(result.layers[0].x,1);assert.equal(result.layers[0].opacity,0.5);assert.equal(result.layers[0].frameId,7);
  for(const change of [s=>s.layers[0].rgbaPath="../other",s=>s.layers[0].rgbaPath="/outside/image.rgba",s=>s.layers[0].rgbaPath="frames//image.rgba",
    s=>s.layers[0].width=0xffffffff,s=>s.layers[0].opacity=NaN,s=>s.layers[0].visible=1,s=>s.canvas.width=16385,s=>s.sequence=1.5,s=>s.layers.push({...s.layers[0]})]) {
    const invalid=structuredClone(input);change(invalid);assert.throws(()=>View.validateScene(invalid,root),/Viewport|viewport/);
  }
  assert.throws(()=>View.validateEvent({type:"pointer",kind:"down",x:0,y:0,button:3,sequence:0}),/bounds/);
  assert.throws(()=>View.validateEvent({type:"ready",protocolVersion:2,version:Helper.VERSION}),/protocol/);
});
function mockChild(onMessage){
  const child=new EventEmitter();child.pid=12345;child.stdout=new PassThrough();child.stderr=new PassThrough();child.messages=[];child.signals=[];
  child.stdin=new Writable({write(bytes,encoding,done){for(const line of bytes.toString().trim().split("\n")){if(!line)continue;const message=JSON.parse(line);child.messages.push(message);onMessage?.(message,child);}done();}});
  child.kill=signal=>{child.signals.push(signal);setImmediate(()=>child.emit("close",0,signal));return true;};
  setImmediate(()=>child.stdout.write(JSON.stringify({type:"ready",protocolVersion:1,version:Helper.VERSION})+"\n"));return child;
}
test("native viewport protocol serializes concurrent scenes, preserves split UTF-8 events and shuts down its own child",async t=>{
  const root=temporary(t),events=[];let child;
  const session=await View.openViewport({cacheRoot:root,helper:{version:Helper.VERSION,protocolVersion:1,executablePath:"/test/viewport"},onEvent:e=>events.push(e),
    spawnChild:()=>child=mockChild((message,c)=>{if(message.type==="close")setImmediate(()=>c.emit("close",0,null));})});
  const a=scene(path.join(session.cacheRoot,"frame.rgba"));delete a.sequence;
  assert.deepEqual(await Promise.all([session.sendScene(a),session.sendScene(a)]),[0,1]);
  await assert.rejects(()=>session.sendScene({...a,sequence:1}),/increase/);
  const line=Buffer.from(JSON.stringify({type:"key",kind:"down",key:"あ",repeat:false})+"\n"),index=line.indexOf(Buffer.from("あ"));
  child.stdout.write(line.subarray(0,index+1));child.stdout.write(line.subarray(index+1));
  assert.equal(events.at(-1).key,"あ");assert.deepEqual(await session.close(),{code:0,signal:null});assert.equal(child.messages.at(-1).type,"close");
  await assert.rejects(()=>session.sendScene(a),/closed/);
});
test("viewport rejects malformed native events and terminates only that child",async t=>{
  const root=temporary(t),events=[];let child;
  const session=await View.openViewport({cacheRoot:root,helper:{version:Helper.VERSION,protocolVersion:1,executablePath:"/test/viewport"},onEvent:e=>events.push(e),spawnChild:()=>child=mockChild()});
  child.stdout.write('{"type":"pointer","kind":"down","x":1,"y":1,"button":99,"sequence":0}\n');await session.closed;
  assert.deepEqual(child.signals,["SIGTERM"]);assert.equal(events.at(-1).type,"error");
});
test("raster conversion validates the child receipt and waits for exit before cleaning aborted output",async t=>{
  const root=temporary(t),helper={version:Helper.VERSION,protocolVersion:1,executablePath:"/test/viewport"},abort=new AbortController();let exited=false;
  await assert.rejects(()=>View.decodeRaster(Buffer.from("fixture"),{cacheRoot:root,helper,width:1,height:1,encoding:"jpeg",signal:abort.signal,
    spawnChild:(executable,args,options)=>{
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
      const output=args[args.indexOf("--output")+1];
      options.signal.addEventListener("abort",()=>{child.emit("error",new Error("Abort"));setTimeout(()=>{fs.writeFileSync(output,Buffer.alloc(4));exited=true;child.emit("close",1,null);},10);},{once:true});
      setImmediate(()=>abort.abort());return child;
    }}),/could not start|Abort/);
  assert.equal(exited,true);assert.equal(fs.readdirSync(path.join(root,"raster")).length,0);
  await assert.rejects(()=>View.decodeRaster(Buffer.from("fixture"),{cacheRoot:root,helper,width:1,height:1,encoding:"jpeg",
    spawnChild:(executable,args)=>{
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
      setImmediate(()=>{fs.writeFileSync(args[args.indexOf("--output")+1],Buffer.alloc(4));child.stdout.write('{"type":"decoded","width":2,"height":1,"bytes":4}\n');child.emit("close",0,null);});return child;
    }}),/disagree/);
  assert.equal(fs.readdirSync(path.join(root,"raster")).length,0);
});
