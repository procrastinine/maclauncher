const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const Icons = require("../src/core/icon-utils"), Dock = require("../src/modules/shared/dock-icon");

test("Generated Dock images round opaque artwork, preserve transparency and refresh old caches", {skip:process.platform!=="darwin"}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dock-icon-"));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const original = path.join(root,"original.png"), directory = path.join(root,"generated");
  const pixels = Buffer.alloc(256*256*4);
  for (let at=0; at<pixels.length; at+=4) {pixels[at]=220; pixels[at+1]=80; pixels[at+2]=40; pixels[at+3]=255;}
  // An existing transparent area inside the rounded silhouette stays clear.
  for (let y=112; y<120; y++) for (let x=112; x<120; x++) pixels[(y*256+x)*4+3]=0;
  const source = Icons.encodePngBitmap({width:256,height:256,buffer:pixels});
  fs.writeFileSync(original,source); fs.mkdirSync(directory);
  const stale = path.join(directory,"dock-icon.png"); fs.writeFileSync(stale,source);
  fs.writeFileSync(path.join(directory,"dock-icon.json"),JSON.stringify({identity:"old-square-style",style:"old"}));
  const prepared = await Dock.prepare(original,directory);
  const png = fs.readFileSync(prepared);
  assert.ok(Dock.prepared(png)); assert.ok(Icons.isSupportedImageBuffer(png));
  assert.deepEqual(fs.readFileSync(original),source,"Original game artwork is unchanged");
  const samples = JSON.parse(execFileSync("/usr/bin/osascript",["-l","JavaScript","-e",`ObjC.import("AppKit");function run(argv){const p=$.NSBitmapImageRep.imageRepWithContentsOfFile(argv[0]);return JSON.stringify([[0,0],[16,16],[25,25],[128,17],[128,128],[116,116],[30,30]].map(q=>{const c=p.colorAtXY(q[0],q[1]);return [c.redComponent,c.greenComponent,c.blueComponent,c.alphaComponent];}));}`,prepared],{encoding:"utf8",timeout:10000}));
  assert.deepEqual(samples.slice(0,3).map(c=>c[3]),[0,0,0],"Padding and rounded corners are transparent");
  assert.ok(samples[3][3]>.99 && samples[4][3]>.99,"The edge center and artwork interior remain opaque");
  assert.ok(samples[4][0]>.75 && samples[4][1]>.2 && samples[4][1]<.4,"Interior artwork keeps its color");
  assert.equal(samples[5][3],0,"Original alpha inside the artwork remains transparent");
  assert.ok(samples[6][3]>0 && samples[6][3]<1,"Native clipping antialiases the rounded edge");
  const before = fs.statSync(prepared).mtimeMs;
  assert.equal(await Dock.prepare(original,directory),prepared);
  assert.equal(fs.statSync(prepared).mtimeMs,before,"Warm launch reuses its generated image");
  assert.deepEqual(await Dock.render(prepared,{runCommand:()=>assert.fail("Already prepared images are not inset a second time")}),png);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory,"dock-icon.json")));
  assert.equal(receipt.style,Dock.style);
  pixels[0]=10; fs.writeFileSync(original,Icons.encodePngBitmap({width:256,height:256,buffer:pixels}));
  await Dock.prepare(original,directory);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(directory,"dock-icon.json"))).identity,receipt.identity,"Artwork changes invalidate the derivative");
});

test("Mac.apk keeps library artwork separate from its rounded generated app and environment image", {skip:process.platform!=="darwin"}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dock-macapk-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const icon=path.join(root,"original.png"),source=Icons.encodePngBitmap({width:256,height:256,buffer:Buffer.alloc(256*256*4,255)});
  fs.writeFileSync(icon,source);
  const storage={runtimeRoot:path.join(root,"provider")},entry={gameId:"game",name:"Mac.apk game",iconPath:icon};
  const executable=path.join(root,"publisher-executable");fs.writeFileSync(executable,"immutable publisher entry");
  t.mock.method(require("../src/modules/android/providers/macapk/executable-identity"),"prepareExecutable",async()=>executable);
  const options={entry,context:{},storage,packageSet:{key:"original-package"},runtime:{},descriptor:{runtime:{version:"1"}}};
  const Identity=require("../src/modules/android/providers/macapk/identity"),application=await Identity.prepareIdentity(options);
  assert.ok(Dock.prepared(fs.readFileSync(application.icon)));
  assert.equal(path.basename(application.icon),"dock-icon.png");
  assert.equal(Identity.resolveIcon(storage),path.join(application.app,"Contents/Resources/icon.png"));
  assert.deepEqual(fs.readFileSync(Identity.resolveIcon(storage)),source,"Library resolution retains the unmasked artwork");
  assert.match(fs.readFileSync(path.join(application.app,"Contents/Info.plist"),"utf8"),/<key>CFBundleIconFile<\/key><string>dock-icon.png<\/string>/);
  const before=fs.statSync(application.icon).mtimeMs;
  await Identity.prepareIdentity(options);assert.equal(fs.statSync(application.icon).mtimeMs,before);
  assert.deepEqual(fs.readFileSync(icon),source);assert.equal(fs.readFileSync(executable,"utf8"),"immutable publisher entry");
});

test("Generated JVM/ART/AIM application bundles replace square cached icons once", {skip:process.platform!=="darwin"}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dock-bundle-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const executable=path.join(root,"entry"),icon=path.join(root,"source.png"),directory=path.join(root,"application");
  fs.writeFileSync(executable,"owned entry");
  const bytes=Icons.encodePngBitmap({width:256,height:256,buffer:Buffer.alloc(256*256*4,255)});fs.writeFileSync(icon,bytes);
  let signs=0;const Application=require("../src/modules/android/application"),execute=async()=>{signs++;};
  const options={executablePath:executable,directory,title:"Rounded game",iconFile:icon};
  const application=await Application.prepare(options,execute);
  const resource=path.join(application.app,"Contents/Resources/Application.icns"),receipt=path.join(directory,"application.json");
  assert.ok(Dock.prepared(fs.readFileSync(resource).subarray(16)));
  assert.equal(JSON.parse(fs.readFileSync(receipt)).basis.iconStyle,Dock.style);
  const old=JSON.parse(fs.readFileSync(receipt));delete old.basis.iconStyle;old.fingerprint="previous-square-entry";
  fs.writeFileSync(receipt,JSON.stringify(old));fs.writeFileSync(resource,Application.icns(bytes));
  await Application.prepare(options,execute);
  assert.ok(Dock.prepared(fs.readFileSync(resource).subarray(16)));assert.equal(signs,2);
  await Application.prepare(options,async()=>assert.fail("Unchanged rounded entries remain cached"));
  assert.deepEqual(fs.readFileSync(icon),bytes);
});

test("JVM Dock arguments and the shared native config receive the same rounded package image", {skip:process.platform!=="darwin"}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dock-package-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const metadata=require("../src/modules/android/package-metadata"),reader=require("../src/modules/android/tools/apk-metadata");
  t.mock.method(reader,"identity",()=>{throw Error("Cached package resources are available offline");});
  const icons=path.join(root,"games/game/icons"),cacheRoot=path.join(root,"prepared");fs.mkdirSync(icons,{recursive:true});fs.mkdirSync(cacheRoot);
  const artwork=Icons.encodePngBitmap({width:256,height:256,buffer:Buffer.alloc(256*256*4,255)});fs.writeFileSync(path.join(icons,"android.png"),artwork);
  const prepared={cacheRoot,sourceApk:path.join(root,"retired-base.apk"),sourceName:"base.apk",apkSha256:"a".repeat(64)};
  const inputs=metadata.preparedSourceIdentity(prepared),context={userDataDir:root,locale:"en-US"};
  fs.writeFileSync(path.join(icons,"android.json"),JSON.stringify({inputIdentity:require("node:crypto").createHash("sha256").update(JSON.stringify([inputs,context.locale])).digest("hex"),label:"Android game",packageName:"game",icon:true}));
  const config={title:"game"};await metadata.applyLaunchIdentity(config,{gameId:"game",gamePath:prepared.sourceApk,name:"game"},prepared,null,null,context);
  assert.equal(path.basename(config.iconFile),"application-icon.png");
  assert.ok(Dock.prepared(fs.readFileSync(config.iconFile)));
  assert.ok(metadata.dockArguments(config).includes("-Xdock:icon="+config.iconFile));
  assert.deepEqual(fs.readFileSync(path.join(icons,"android.png")),artwork);
});
