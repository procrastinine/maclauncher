const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Tools = require("../src/modules/video/tools"), Export = require("../src/modules/video/export");
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),"video-export-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test("Preview uses the ordinary launch flow and the current saved settings",async()=>{
  const entry={gamePath:"/video.mp4",graphics:{spatialMethod:"metalfx"}},settings={runtimes:{}},signal=new AbortController().signal;
  let received;const result=await Tools.previewVideo(entry,{}, {settings,signal,launchForTools:async options=>{received=options;return {kind:"process"};}});
  assert.equal(received.settings,settings);assert.equal(received.signal,signal);assert.equal(received.runtimeId,"mpv");assert.match(result.message,/preview opened/);
  assert.deepEqual(await Tools.previewVideo(entry,{}, {launchForTools:async()=>({kind:"cancelled"})}),{canceled:true});
});
test("Export resolution and save cancellation do not start processing",async t=>{
  const root=temporary(t),input=path.join(root,"input.mp4");fs.writeFileSync(input,"source");let calls=0;
  const context={ui:{dialog:{showMessageBox:async()=>({response:3})}}};
  assert.deepEqual(await Tools.exportVideo({gamePath:input},{},context,{exportVideo:async()=>calls++}),{canceled:true});
  context.ui.dialog={showMessageBox:async()=>({response:1}),showSaveDialog:async()=>({canceled:true})};
  assert.deepEqual(await Tools.exportVideo({gamePath:input},{},context,{exportVideo:async()=>calls++}),{canceled:true});assert.equal(calls,0);
});
test("Export preserves Advanced order and explicit downsample sizes without mutating settings",()=>{
  const entry={effects:{schema:1,mode:"advanced",video:[{id:"down",kind:"spatial",enabled:true,method:"bicubic",settings:{spatialMultiplier:.5}},
    {id:"up",kind:"spatial",enabled:true,method:"metalfx",settings:{spatialMultiplier:null}}]}};
  const original=structuredClone(entry),plan=Export.exportPlan(entry,{});
  assert.deepEqual(plan.video.map(row=>row.id),["down","up"]);assert.equal(plan.video[0].settings.spatialMultiplier,.5);assert.deepEqual(entry,original);
  entry.effects.video.push({id:"generation",kind:"frame-generation",enabled:true,method:"lsfg",settings:{}});
  assert.throws(()=>Export.exportPlan(entry,{}),/paired video-frame output/);
  const available = Export.exportPlan(entry, {features: {graphics: {videoFrameAPI: 2, videoFrameGenerationMethods: ["lsfg"]}}});
  assert.equal(available.video.at(-1).method, "lsfg");
});
test("Export rejects unsafe outputs and invalid geometry before processing",t=>{
  const root=temporary(t),input=path.join(root,"input.mp4"),output=path.join(root,"output.mp4");fs.writeFileSync(input,"source");fs.writeFileSync(output,"existing");
  assert.throws(()=>Export.outputFile(input,input),/separate/);assert.throws(()=>Export.outputFile(input,output),/already exists/);
  assert.throws(()=>Export.dimensions({width:641,height:480}),/even/);assert.throws(()=>Export.dimensions({width:640,height:480,scale:2}),/dimensions or a scale/);
  assert.equal(fs.readFileSync(input,"utf8"),"source");assert.equal(fs.readFileSync(output,"utf8"),"existing");
});
test("scene generation reports missing decoder inputs through the shared implementation contract",()=>{
  for(const method of ["metalfx","fsr3","xess"]){
    const entry={effects:{schema:2,mode:"advanced",video:[{id:"scene-generation",kind:"frame-generation",enabled:true,method,settings:{frameMultiplier:2}}]}};
    assert.throws(()=>Export.exportPlan(entry,{features:{graphics:{videoFrameAPI:2,videoFrameGenerationMethods:[method]}}}),/matching renderer guides/);
  }
});
test("export preflights typed scene-filter inputs independently from legacy depth traits",t=>{
  const ReShade=require("../src/modules/shared/reshade");let selected={requirements:{depth:true,projectionMatrix:true},traits:{preservesCoordinates:true}};
  t.mock.method(ReShade,"resolveShaderSelection",()=>selected);
  const entry={effects:{schema:2,mode:"advanced",enabled:true,video:[{id:"filter",kind:"shader",enabled:true,shader:{enabled:true,preset:"grayscale"}}]}};
  assert.throws(()=>Export.exportPlan(entry),/renderer inputs \(depth, projection matrix\)/);
  selected={requirements:[],traits:{sceneInputs:["projectionMatrix"]}};
  assert.throws(()=>Export.exportPlan(entry),/renderer inputs \(projection matrix\)/);
  selected={requirements:[],traits:{preservesCoordinates:true}};
  assert.equal(Export.exportPlan(entry).video[0].id,"filter");
});
test("schema2 export preserves explicit reduction, neural upscale and derived-plane hook order", t => {
  const root = temporary(t), hook = path.join(root, "luma.hook");
  fs.writeFileSync(hook, "//!HOOK LUMA\n//!BIND HOOKED\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}\n");
  const entry = {effects: {schema: 2, mode: "advanced", enabled: true, renderResolution: {height: 480}, video: [
    {id: "reduce", kind: "downsample", enabled: true, method: "bilinear", settings: {}, extent: {relativeTo: "input", factor: .5}},
    {id: "vsr", kind: "upscale", enabled: true, method: "mlx-vsr", settings: {modelPath: path.join(root, "vsr.srmodel"), temporal: false, intensity: 1}},
    {id: "luma", kind: "shader", enabled: true, shader: {enabled: true, preset: "custom", effectPath: hook}}
  ]}}, before = structuredClone(entry);
  assert.throws(() => Export.exportPlan(entry, {root}), /derived-plane adapter/);
  const plan = Export.exportPlan(entry, {root, features: {shaders: {providers: {libplacebo: {derivedPlanes: true}}}}});
  assert.deepEqual(plan.video.map(row => row.id), ["reduce", "vsr", "luma"]);
  assert.deepEqual(plan.video[0].extent, {relativeTo: "input", factor: .5});assert.equal(plan.video[1].method, "mlx-vsr");
  assert.equal(plan.renderResolution, undefined);assert.deepEqual(entry, before);
});
test("schema2 bypass exports original pixels without model acquisition or shader reads", async t => {
  const root = temporary(t), input = path.join(root, "input.mp4"), output = path.join(root, "output.mp4");fs.writeFileSync(input, "source");
  const entry = {effects: {schema: 2, mode: "advanced", enabled: false, video: [
    {id: "missing-shader", kind: "shader", enabled: true, shader: {enabled: true, preset: "custom", effectPath: "/missing.hook"}},
    {id: "missing-model", kind: "upscale", enabled: true, method: "mlx-vsr", settings: {modelPath: "/missing.srmodel", temporal: false, intensity: 1}}
  ]}}, before = structuredClone(entry);
  const result = await Export.exportVideo({entry, input, output, scale: 1, context: {userDataDir: root, graphicsRuntimeRoot: root, platform: "darwin", macOSVersion: "27.0"}}, {
    manifest: {files: [{path: "maclauncher-graphics-video"}]}, verifyFile: () => {}, withRuntimeUse: () => assert.fail("bypass acquired a model"),
    prepare: async job => {assert.equal(job.effects.enabled, false);return {file: path.join(root, "games", job.gameId, "plan.json"), environment: {}};},
    run: async () => ({output})
  });
  assert.equal(result.output, output);assert.deepEqual(entry, before);assert.equal(fs.readFileSync(input, "utf8"), "source");
});
test("Export snapshots its plan outside the game's live profile and cleans it after failure",async t=>{
  const root=temporary(t),input=path.join(root,"input.mp4"),output=path.join(root,"output.mp4");fs.writeFileSync(input,"source");
  const live=path.join(root,"games","movie","effects","reshade");fs.mkdirSync(live,{recursive:true});fs.writeFileSync(path.join(live,"effect-plan.json"),"live-plan");
  const entry={gameId:"movie",gamePath:input,effects:{schema:1,mode:"advanced",video:[]}},before=structuredClone(entry);let preparedEntry;
  const options={entry,input,output,scale:2,context:{userDataDir:root,graphicsRuntimeRoot:root,platform:"darwin",macOSVersion:"27.0"}};
  await assert.rejects(Export.exportVideo(options,{manifest:{files:[{path:"maclauncher-graphics-video"}]},verifyFile:()=>{},
    prepare:async job=>{preparedEntry=job;const directory=path.join(root,"games",job.gameId,"effects","reshade");fs.mkdirSync(directory,{recursive:true});return {file:path.join(directory,"effect-plan.json"),environment:{}};},
    run:async call=>{assert.equal(call.env.RESHADE_EXPLICIT_HOST,"1");assert.ok(call.args.includes("--scale"));throw new Error("decoder error");}}),/decoder error/);
  assert.notEqual(preparedEntry.gameId,entry.gameId);assert.deepEqual(entry,before);assert.equal(fs.existsSync(path.join(root,"games",preparedEntry.gameId)),false);
  assert.equal(fs.readFileSync(path.join(live,"effect-plan.json"),"utf8"),"live-plan");assert.equal(fs.readFileSync(input,"utf8"),"source");
});
test("Export retains selected managed models through preparation and child ownership",async t=>{
  const root=temporary(t),input=path.join(root,"input.mp4"),output=path.join(root,"output.mp4"),events=[];fs.writeFileSync(input,"source");
  const Neural=require("../src/modules/shared/reshade/neural"),identity={managerId:"graphics-neural-models",version:"local-model"};
  t.mock.method(Neural,"modelIdentity",()=>identity);
  const entry={effects:{schema:2,mode:"advanced",enabled:true,video:[{id:"nn",kind:"neural",enabled:true,method:"mlx-dlss",settings:{modelPath:path.join(root,"model.dlssmodel")}}]}};
  const result=await Export.exportVideo({entry,input,output,scale:1,context:{userDataDir:root,graphicsRuntimeRoot:root,platform:"darwin",macOSVersion:"27.0",
    onToolProcessSpawn:async(_child,options)=>{assert.deepEqual(options,{stopOnLauncherExit:true,shutdownGraceMs:15000});events.push("owned");}}}, {manifest:{files:[{path:"maclauncher-graphics-video"}]},verifyFile:()=>{},
    withRuntimeUse:async(identities,run)=>{assert.deepEqual(identities,[identity]);events.push("lease");try{return await run({retainUntilClosed:async()=>events.push("bound")});}finally{events.push("released");}},
    prepare:async job=>{events.push("prepared");return {file:path.join(root,"games",job.gameId,"plan.json"),environment:{}};},
    run:async call=>{await call.onToolProcessSpawn({pid:123},{stopOnLauncherExit:true,shutdownGraceMs:15000});events.push("processed");return {output};}});
  assert.equal(result.output,output);assert.deepEqual(events,["lease","prepared","bound","owned","processed","released"]);
});
test("graphics export process declares its actual cooperative cleanup budget", async t => {
  const root=temporary(t),output=path.join(root,"output.mp4");let ownership;
  const result=await require("../src/modules/video/export-process").run({executable:process.execPath, output,
    args:["-e",`require('node:fs').writeFileSync(${JSON.stringify(output)},'output');console.log(JSON.stringify({type:'complete',output:${JSON.stringify(output)},outputFrames:1}));`],
    onToolProcessSpawn:async(child,options)=>{assert.ok(child.pid>0);ownership=options;}});
  assert.equal(result.output,output);assert.deepEqual(ownership,{stopOnLauncherExit:true,shutdownGraceMs:15000});
});
test("Automatic export leases the operation's selected model before preparation and preserves the saved choice",async t=>{
  const root=temporary(t),input=path.join(root,"input.mp4"),output=path.join(root,"output.mp4"),events=[];fs.writeFileSync(input,"source");
  const general={version:"general",operation:"realesrgan",curatedDefault:true,modelPath:path.join(root,"general.restorationmodel")},
    anime={version:"anime",operation:"realesrgan",modelPath:path.join(root,"anime.restorationmodel")},
    nr={version:"nr",operation:"mlx-dlss",modelPath:path.join(root,"nr.dlssmodel")},identity={managerId:"graphics-neural-models",version:"anime"};
  const Neural=require("../src/modules/shared/reshade/neural");t.mock.method(Neural,"modelIdentity",(_root,selected)=>{assert.equal(selected,anime.modelPath);return identity;});
  const entry={effects:{schema:2,mode:"advanced",enabled:true,video:[{id:"image",kind:"upscale",enabled:true,method:"realesrgan",settings:{modelPath:null}}]}},before=structuredClone(entry);
  await Export.exportVideo({entry,input,output,scale:1,context:{userDataDir:root,graphicsRuntimeRoot:root,platform:"darwin",macOSVersion:"27.0",settings:{runtimes:{"graphics-neural-models":{defaultVersion:"nr",defaultVersions:{realesrgan:"anime"}}}}}}, {
    manifest:{files:[{path:"maclauncher-graphics-video"}]},verifyFile:()=>{},
    prepareModels:async(plan,options)=>{events.push("model");assert.equal(plan.video[0].settings.modelPath,null);assert.equal(options.launchPreparation,true);return{models:[nr,general,anime],pending:[]};},
    withRuntimeUse:async(identities,run)=>{assert.deepEqual(identities,[identity]);events.push("lease");try{return await run({retainUntilClosed:async()=>events.push("bound")});}finally{events.push("released");}},
    prepare:async job=>{events.push("prepared");assert.equal(job.effects.video[0].settings.modelPath,anime.modelPath);return{file:path.join(root,"games",job.gameId,"plan.json"),environment:{}};},
    run:async call=>{await call.onToolProcessSpawn({pid:123});events.push("processed");return{output};}
  });
  assert.deepEqual(entry,before);assert.deepEqual(events,["model","lease","prepared","bound","processed","released"]);
});
test("export does not start an incomplete file job when a requested Automatic model remains missing",async t=>{
  const root=temporary(t),input=path.join(root,"input.mp4"),output=path.join(root,"output.mp4");fs.writeFileSync(input,"source");
  const entry={effects:{schema:2,mode:"advanced",enabled:true,video:[{id:"image",kind:"upscale",enabled:true,method:"mlx-vsr",settings:{modelPath:null}}]}};
  await assert.rejects(Export.exportVideo({entry,input,output,scale:1,context:{userDataDir:root,graphicsRuntimeRoot:root,platform:"darwin",macOSVersion:"27.0"}}, {
    prepareModels:async()=>({models:[],pending:[{reason:"A compatible model is needed."}]}),
    withRuntimeUse:()=>assert.fail("missing model acquired a lease"),prepare:()=>assert.fail("incomplete graph prepared"),run:()=>assert.fail("incomplete export started")
  }),/compatible model is needed/);
  assert.equal(fs.existsSync(output),false);
});
test("export completion preserves actual codec and HDR metadata and rejects inconsistent encoding",async t=>{
  const root=temporary(t),run=require("../src/modules/video/export-process").run;
  for(const encoding of [{codec:"h264",hdr:false},{codec:"hevc-main10",hdr:true}]){
    const output=path.join(root,encoding.codec+".mp4");
    const result=await run({executable:process.execPath,output,args:["-e",`require('node:fs').writeFileSync(${JSON.stringify(output)},'output');console.log(JSON.stringify({type:'complete',output:${JSON.stringify(output)},outputFrames:1,...${JSON.stringify(encoding)}}));`]});
    assert.equal(result.codec,encoding.codec);assert.equal(result.hdr,encoding.hdr);
  }
  const output=path.join(root,"invalid.mp4");await assert.rejects(run({executable:process.execPath,output,args:["-e",`console.log(JSON.stringify({type:'complete',output:${JSON.stringify(output)},outputFrames:1,codec:'h264',hdr:true}));`]}),/Invalid video export encoding/);
});
test("paired export distinguishes decoded, generated and held frames", async t => {
  const root=temporary(t),output=path.join(root,"paired.mp4");
  const result=await require("../src/modules/video/export-process").run({executable:process.execPath,output,
    args:["-e",`require('node:fs').writeFileSync(${JSON.stringify(output)},'output');console.log(JSON.stringify({type:'complete',output:${JSON.stringify(output)},outputFrames:48,inputFrames:24,generatedFrames:22,repeatedFrames:2}));`]});
  assert.equal(result.inputFrames,24);assert.equal(result.generatedFrames,22);assert.equal(result.repeatedFrames,2);
  await assert.rejects(require("../src/modules/video/export-process").run({executable:process.execPath,output,
    args:["-e",`console.log(JSON.stringify({type:'complete',output:${JSON.stringify(output)},outputFrames:48,inputFrames:24,generatedFrames:24,repeatedFrames:2}));`]}),/frame counts/);
});
test("adaptive export retains real timing scope and an explicit pending reason",async t=>{
  const root=temporary(t),run=require('../src/modules/video/export-process').run;
  for(const state of ['pending','active']){
    const output=path.join(root,state+'.mp4'),quality={nodeId:'reduce',state,scale:.75,meanMilliseconds:state==='active'?4.5:0,scope:state==='active'?'offline-frame':'unknown',reason:state==='active'?'':"The affected provider uses a separate GPU queue."};let progress;
    const result=await run({executable:process.execPath,output,args:['-e',`const fs=require('node:fs'),quality=${JSON.stringify(quality)},output=${JSON.stringify(output)};console.log(JSON.stringify({type:'progress',fraction:.5,outputFrames:1,adaptiveQuality:quality}));fs.writeFileSync(output,'owned');console.log(JSON.stringify({type:'complete',output,outputFrames:2,adaptiveQuality:quality}));`],onProgress:event=>{progress=event;}});
    assert.deepEqual(result.adaptiveQuality,quality);assert.deepEqual(progress.adaptiveQuality,quality);assert.equal(result.adaptiveQualitySummary,state==='active'?'75% · Offline frame 4.50 ms':'Timing pending');assert.doesNotMatch(result.adaptiveQualitySummary,/0\.00 ms/);
  }
  const output=path.join(root,'invalid.mp4');await assert.rejects(run({executable:process.execPath,output,args:['-e',`console.log(JSON.stringify({type:'complete',output:${JSON.stringify(output)},outputFrames:1,adaptiveQuality:{nodeId:'reduce',state:'active',scale:1,meanMilliseconds:0,scope:'unknown',reason:''}}));`]}),/adaptive-quality status/);
});
test("export retains the actual output mapping and nonfatal source fallback in progress and results",async t=>{
 const root=temporary(t),output=path.join(root,'color.mp4'),{run}=require('../src/modules/video/export-process');let progress;
 const outputColor={requested:'pbr-neutral',active:'auto',reason:'PBR Neutral requires declared scene-referred input; Automatic mapping remains active.'};
 const result=await run({executable:process.execPath,output,args:['-e',`const fs=require('node:fs'),outputColor=${JSON.stringify(outputColor)},output=${JSON.stringify(output)};console.log(JSON.stringify({type:'progress',fraction:.5,outputFrames:1,outputColor}));fs.writeFileSync(output,'owned');console.log(JSON.stringify({type:'complete',output,outputFrames:2,outputColor}));`],onProgress:event=>{progress=event;}});
 assert.deepEqual(result.outputColor,outputColor);assert.deepEqual(progress.outputColor,outputColor);assert.equal(result.outputColorSummary,'Automatic (requested PBR Neutral)');
 await assert.rejects(run({executable:process.execPath,output,args:['-e',`console.log(JSON.stringify({type:'complete',output:${JSON.stringify(output)},outputFrames:1,outputColor:{requested:'pbr-neutral',active:'guessed',reason:''}}));`]}),/output color status/);
});
test("export progress observers cannot stop encoding or reject a completed output", async t => {
  const root=temporary(t);
  for (const asynchronous of [false,true]) for (const asynchronousLogger of [false,true]) {
    const output=path.join(root,`${asynchronous}-${asynchronousLogger}.mp4`);let observations=0,warnings=0;
    const result=await require("../src/modules/video/export-process").run({executable:process.execPath,output,
      args:["-e",`console.log(JSON.stringify({type:'progress',fraction:0.5,outputFrames:1}));setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(output)},'output');console.log(JSON.stringify({type:'complete',output:${JSON.stringify(output)},outputFrames:2}));},30);`],
      onProgress:()=>{observations++;if(asynchronous)return Promise.reject(new Error("observer unavailable"));throw new Error("observer unavailable");},
      logger:{warn:()=>{warnings++;if(asynchronousLogger)return Promise.reject(new Error("logger unavailable"));throw new Error("logger unavailable");}}});
    assert.equal(result.output,output);assert.equal(result.outputFrames,2);assert.equal(observations,1);assert.equal(warnings,1);
    assert.equal(fs.readFileSync(output,"utf8"),"output");
  }
});
test("invalid export progress remains a protocol failure", async t => {
  const root=temporary(t),output=path.join(root,"invalid.mp4");let observations=0;
  await assert.rejects(require("../src/modules/video/export-process").run({executable:process.execPath,output,
    args:["-e","console.log(JSON.stringify({type:'progress',fraction:2,outputFrames:1}));setTimeout(()=>{},10000);"],
    onProgress:()=>observations++}),/Invalid export progress/);
  assert.equal(observations,0);assert.equal(fs.existsSync(output),false);
});
test("completed export filesystem validation errors reject instead of escaping its close handler", {timeout: 5000}, async t => {
  const root=temporary(t),stat=fs.statSync;
  for (const code of ["EACCES","ENOTDIR"]) {
    const output=path.join(root,code+".mp4"),failure=Object.assign(new Error("Output validation failed"),{code});
    const mocked=t.mock.method(fs,"statSync",function(file,...args){if(file===output)throw failure;return Reflect.apply(stat,this,[file,...args]);});
    try {
      await assert.rejects(require("../src/modules/video/export-process").run({executable:process.execPath,output,
        args:["-e",`require('node:fs').writeFileSync(${JSON.stringify(output)},'output');console.log(JSON.stringify({type:'complete',output:${JSON.stringify(output)},outputFrames:1}));`]}),error=>error===failure);
      assert.equal(fs.readFileSync(output,"utf8"),"output");
    } finally {mocked.mock.restore();}
  }
});
test("Export leaves out an unreadable row, logs it and keeps the other rows in order",()=>{
  const effects={schema:2,mode:"advanced",enabled:true,video:[{id:"down",kind:"spatial",enabled:true,method:"bicubic",settings:{spatialMultiplier:.5}},
    {id:"broken",kind:"spatial",enabled:true,method:"bilinear",settings:{},future:true},{id:"up",kind:"spatial",enabled:true,method:"metalfx",settings:{}}]};
  const entry={effects},original=structuredClone(entry),warnings=[];
  const plan=Export.exportPlan(entry,{logger:{warn:message=>warnings.push(message)}});
  assert.deepEqual(plan.video.map(row=>row.id),["down","up"]);assert.deepEqual(entry,original);
  assert.equal(warnings.length,1);assert.match(warnings[0],/Video export: The saved effect “bilinear” is skipped\./);
  assert.throws(()=>Export.exportPlan({effects:{...effects,schema:3}}),/newer version/);
});
