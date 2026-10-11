const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { decodeCursor } = require("../src/modules/catsystem2/cursor-file"), { parseCursorDefinitions, createFrontEndCursor } = require("../src/modules/catsystem2/runtime/frontend-cursor");
const { parseXml } = require("../src/modules/catsystem2/startup"), View = require("../src/modules/catsystem2/viewport-v2");
const Helper = require("../src/modules/catsystem2/runtime/viewport-v2-helper"), { EventEmitter } = require("node:events"), { PassThrough, Writable } = require("node:stream");
function image() {
  const bytes = Buffer.alloc(22 + 40 + 16 + 8); bytes.writeUInt16LE(2, 2); bytes.writeUInt16LE(1, 4); bytes[6] = 2; bytes[7] = 2;
  bytes.writeUInt16LE(1, 10); bytes.writeUInt32LE(bytes.length - 22, 14); bytes.writeUInt32LE(22, 18);
  bytes.writeUInt32LE(40, 22); bytes.writeInt32LE(2, 26); bytes.writeInt32LE(4, 30); bytes.writeUInt16LE(1, 34); bytes.writeUInt16LE(32, 36);
  Buffer.from([255,0,0,255,255,255,255,0,0,0,255,255,0,255,0,128]).copy(bytes, 62); return bytes;
}
test("Windows cursors retain hotspot, bottom-up BGRA geometry and straight alpha without source mutation", () => {
  const bytes = image(), before = Buffer.from(bytes), decoded = decodeCursor(bytes);
  assert.deepEqual({width:decoded.width,height:decoded.height,x:decoded.hotspotX,y:decoded.hotspotY}, {width:2,height:2,x:1,y:0});
  assert.deepEqual(decoded.rgba, Buffer.from([255,0,0,255,0,255,0,128,0,0,255,255,255,255,255,0])); assert.deepEqual(bytes, before);
  for (const mutation of [b=>b.writeUInt16LE(1,2),b=>b.writeUInt16LE(0,4),b=>b.writeUInt32LE(0xffffffff,14),b=>b.writeUInt32LE(21,18),
    b=>b.writeUInt16LE(2,10),b=>b.writeInt32LE(2,30),b=>b.writeUInt16LE(24,36),b=>b.writeUInt32LE(3,38),b=>b.writeUInt32LE(1,54)]) {
    const invalid = image(); mutation(invalid); assert.throws(()=>decodeCursor(invalid),/cursor/);
  }
  assert.throws(()=>decodeCursor(bytes.subarray(0,-1)),/cursor/); assert.throws(()=>decodeCursor(bytes,{index:1}),/absent/);
});
test("legacy cursor alpha uses the AND mask and rejects inversion instead of guessing", () => {
  const bytes = image(); for (let offset = 65; offset < 78; offset += 4) bytes[offset] = 0;
  bytes[78] = 0x40; bytes.fill(0,66,69); const decoded = decodeCursor(bytes);
  assert.deepEqual([...decoded.rgba].filter((_,i)=>i%4===3),[255,255,255,0]); bytes[66] = 1;
  assert.throws(()=>decodeCursor(bytes),/inversion/);
});
test("authored cursor definitions reject traversal, duplicates and unsupported animated cursors", () => {
  assert.equal(parseCursorDefinitions(Buffer.from('<document><default>cursor\\normal.cur</default></document>')).get('default'),'cursor/normal.cur');
  for (const text of ['<document><default>../other.cur</default></document>','<document><default>a.cur</default><DEFAULT>b.cur</DEFAULT></document>',
    '<document><default>a.ani</default></document>','<document><hover>a.cur</hover></document>']) assert.throws(()=>parseCursorDefinitions(Buffer.from(text)),/cursor|unsafe/);
});
test("cursor service reads authored files once, reuses derived pixels and applies real named changes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'maclauncher-cs-cursors-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const original = image(), changes = [], reads = [], service = await createFrontEndCursor({cacheRoot:root,document:parseXml(Buffer.from('<document><CURSOR><type>1</type></CURSOR></document>')),
    registry:{read:async(type,name)=>{assert.equal(type,'config');assert.equal(name,'cursor');return Buffer.from('<document><default>cursor/normal.cur</default><hover>cursor/hover.cur</hover></document>');}},
    assets:{read:async name=>{reads.push(name);return original;}},presentCursor:async cursor=>changes.push(cursor)});
  const first = await service.select(), again = await service.select(); assert.deepEqual(first,again); assert.equal(changes.length,1);
  await service.select('hover',[0,1]); assert.deepEqual(reads,['cursor/normal.cur','cursor/hover.cur']); assert.equal(changes.length,2); assert.equal(changes[1].hotspotY,1);
  assert.equal(fs.readdirSync(path.join(root,'cursors')).length,1); assert.deepEqual(original,image());
  await assert.rejects(()=>service.select('absent'),/unsupported/); await assert.rejects(()=>service.select('default',[2,0]),/exceeds/);
  const fresh = await createFrontEndCursor({cacheRoot:root,document:parseXml(Buffer.from('<document><CURSOR><type>1</type></CURSOR></document>')),
    registry:{read:async()=>Buffer.from('<document><default>cursor/normal.cur</default></document>')},assets:{read:async()=>original},presentCursor:async()=>{}});
  fs.writeFileSync(first.rgbaPath,Buffer.alloc(16)); await assert.rejects(()=>fresh.select(),/modified/);
});
test("viewport2 cursor contract bounds geometry, hotspots, native names and cache-root paths", () => {
  const root = path.resolve('/cache'), cursor = {kind:'image',rgbaPath:'/cache/cursors/one.rgba',width:2,height:2,hotspotX:1,hotspotY:0};
  assert.equal(View.validateCursor(cursor,root,0).type,'cursor'); assert.equal(View.validateCursor({kind:'system',name:'arrow'},root,1).cursor.name,'arrow');
  for (const mutation of [c=>c.width=257,c=>c.hotspotX=2,c=>c.hotspotY=-1,c=>c.rgbaPath='../secret',c=>c.kind='animated']) {
    const invalid={...cursor}; mutation(invalid); assert.throws(()=>View.validateCursor(invalid,root,0),/cursor|Viewport/);
  }
  assert.throws(()=>View.validateCursor({kind:'system',name:'default'},root,0),/cursor/);
  assert.deepEqual(View.validateEvent({type:'cursor-set',sequence:0}),{type:'cursor-set',sequence:0});
});
function nativeChild(onMessage) {
  const child=new EventEmitter();child.pid=12345;child.stdout=new PassThrough();child.stderr=new PassThrough();child.messages=[];child.signals=[];
  child.stdin=new Writable({write(bytes,encoding,done){for(const line of bytes.toString().trim().split('\n')){const message=JSON.parse(line);child.messages.push(message);
    if(message.type==='close')setImmediate(()=>child.emit('close',0,null));else onMessage?.(message,child);}done();}});
  child.kill=signal=>{child.signals.push(signal);setImmediate(()=>child.emit('close',1,signal));};
  setImmediate(()=>child.stdout.write(JSON.stringify({type:'ready',protocolVersion:2,version:Helper.VERSION})+'\n'));return child;
}
test("cursor changes wait for actual native confirmation and preserve the independent increasing cursor sequence",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'maclauncher-cs-cursor-child-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let child,confirmation;
  const viewport=await View.openViewport({cacheRoot:root,helper:{version:Helper.VERSION,protocolVersion:2,executablePath:'/test/viewport'},spawnChild:()=>child=nativeChild((message,c)=>{
    if(message.type==='cursor')confirmation=()=>c.stdout.write(JSON.stringify({type:'cursor-set',sequence:message.sequence})+'\n');})});
  let applied=false;const pending=viewport.setCursor({kind:'system',name:'arrow'}).then(value=>{applied=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(applied,false);confirmation();assert.equal(await pending,0);
  const second=viewport.setCursor({kind:'image',rgbaPath:path.join(viewport.cacheRoot,'cursor.rgba'),width:1,height:1,hotspotX:0,hotspotY:0});await new Promise(resolve=>setImmediate(resolve));confirmation();assert.equal(await second,1);
  assert.deepEqual(child.messages.map(x=>x.sequence),[0,1]);await viewport.close();assert.deepEqual(child.signals,[]);
});
test("unexpected native cursor confirmations fail the owning child and reject pending changes",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'maclauncher-cs-cursor-invalid-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let child;
  const viewport=await View.openViewport({cacheRoot:root,helper:{version:Helper.VERSION,protocolVersion:2,executablePath:'/test/viewport'},spawnChild:()=>child=nativeChild((message,c)=>{
    if(message.type==='cursor')setImmediate(()=>c.stdout.write('{"type":"cursor-set","sequence":99}\n'));})});
  await assert.rejects(()=>viewport.setCursor({kind:'system',name:'arrow'}),/closed before/);assert.deepEqual(child.signals,['SIGTERM']);await viewport.close();
});
