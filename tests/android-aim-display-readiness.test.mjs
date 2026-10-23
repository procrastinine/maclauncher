import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {adaptDisplayReadiness,adaptDisplayTitle} from '../src/modules/android/providers/aim/source.mjs';

const relative='crates/aim-host-display/src/bin/aim-display/main.rs';
const upstream=path.resolve(process.env.ANDROID_AIM_DISPLAY_SOURCE||'src/external/aim');
function original(t) {
  if(!fs.existsSync(path.join(upstream,relative))) {t.skip('Requires the pinned AIM source');return null;}
  return fs.readFileSync(path.join(upstream,relative),'utf8');
}
function startup(text) {
  const start=text.indexOf('    let targets: Vec<Target> = win');
  const end=text.indexOf('    std::thread::spawn(|| {\n        loop {',start);
  assert.ok(start>=0&&end>start,'Original display startup anchors remain exact');
  return text.slice(start,end);
}
function run(command,args,options={}) {
  const r=spawnSync(command,args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20,...options});
  assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);
  assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;
}

test('AIM display adaptation only moves the guarded initial draw after serving begins',t=>{
  const text=original(t);if(!text)return;
  const fixed=adaptDisplayReadiness(text);
  const old='    // The display is black until the first frame.\n    renderer.present(None, &targets, None);\n';
  const guard=fixed.slice(fixed.indexOf('    // Readiness must not wait'),fixed.indexOf('    std::thread::spawn(|| {\n        loop {',fixed.indexOf('    // Readiness must not wait')));
  assert.ok(guard.includes('let last = display.last.lock().unwrap();'));
  assert.ok(guard.indexOf('last.is_none()')<guard.indexOf('display.targets.lock()'));
  assert.ok(guard.indexOf('display.targets.lock()')<guard.indexOf('display.renderer.present(None'));
  assert.equal(fixed.replace(guard,'').replace('\n    let period = vsync::create',old+'\n    let period = vsync::create'),text);
  assert.throws(()=>adaptDisplayReadiness(fixed),/no longer matches/);
});

test('actual startup block accepts a Unix handshake while the first render is blocked',{timeout:45000},t=>{
  const text=original(t);if(!text)return;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aim-display-readiness-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const fixture=fs.readFileSync(fileURLToPath(new URL('./fixtures/android-aim-display/readiness.rs',import.meta.url)),'utf8');
  const compiler=process.env.ANDROID_AIM_RUSTC||'rustc';
  for(const [name,source]of [['original',text],['fixed',adaptDisplayReadiness(text)]]) {
    const sourceFile=path.join(root,name+'.rs'),executable=path.join(root,name);
    fs.writeFileSync(sourceFile,fixture.replace('/* ORIGINAL_STARTUP */',startup(source)));
    run(compiler,['--edition=2024','--crate-name','display_readiness',sourceFile,'-o',executable]);
    t.diagnostic(run(executable,[name,path.join(root,name+'.sock')]).trim());
    if(name==='fixed')t.diagnostic(run(executable,['early',path.join(root,'early.sock')]).trim());
  }
});

test('actual display argument parser uses its bundle title, falls back, and honors explicit --title',t=>{
  const text=original(t);if(!text)return;
  const fixed=adaptDisplayTitle(text),start=fixed.indexOf('    let mut args = std::env::args().skip(1);');
  const end=fixed.indexOf('    let Some(socket) = socket else {',start);
  assert.ok(start>=0&&end>start);
  assert.equal(fixed.replace('    let mut title = shim::info("CFBundleDisplayName").unwrap_or_else(|| "Android".to_string());','    let mut title = "Android".to_string();'),text);
  assert.throws(()=>adaptDisplayTitle(fixed),/no longer matches/);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aim-display-title-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const fixture=fs.readFileSync(fileURLToPath(new URL('./fixtures/android-aim-display/title.rs',import.meta.url)),'utf8');
  const source=path.join(root,'title.rs'),executable=path.join(root,'title');
  fs.writeFileSync(source,fixture.replace('/* ORIGINAL_ARGUMENT_PARSER */',fixed.slice(start,end)));
  run(process.env.ANDROID_AIM_RUSTC||'rustc',['--edition=2024',source,'-o',executable]);
  const env={...process.env};delete env.AIM_TEST_BUNDLE_TITLE;
  assert.equal(run(executable,[],{env}).trim(),'Android');
  assert.equal(run(executable,[],{env:{...env,AIM_TEST_BUNDLE_TITLE:'Shattered Pixel Dungeon'}}).trim(),'Shattered Pixel Dungeon');
  assert.equal(run(executable,['--title','Explicit display title'],{env:{...env,AIM_TEST_BUNDLE_TITLE:'Bundle title'}}).trim(),'Explicit display title');
  assert.equal(run(executable,['--title','Explicit without bundle'],{env}).trim(),'Explicit without bundle');
});
