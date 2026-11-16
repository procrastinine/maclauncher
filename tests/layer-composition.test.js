'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const native=path.join(__dirname,'../src/modules/shared/reshade/native');

test('a game layer composes opaquely through its opaque property or the Vulkan WSI declaration', t => {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'layer-composition-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const binary=path.join(directory,'check');
 const build=spawnSync('xcrun',['clang++','-std=c++17','-fobjc-arc','-Wall','-Wextra','-Werror','-I'+native,path.join(__dirname,'native/layer-composition.mm'),'-framework','QuartzCore','-framework','Foundation','-o',binary],{encoding:'utf8'});
 assert.equal(build.status,0,build.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8'});assert.ifError(run.error);assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/layer-composition: pass 6/);
});

test('the Metal presentation hooks read a game layer\'s opacity through its composition', () => {
 const source=fs.readFileSync(path.join(native,'metal.mm'),'utf8');
 assert.match(source,/#include "layer-composition\.h"/);
 // KosmicKrisp keeps CAMetalLayer.opaque false; frame generation and color descriptions follow the composition.
 assert.doesNotMatch(source,/\blayer\.opaque\b/);
 assert.match(source,/presentation->submitDisplayFrame\(buffer,source,0,sourceTime>0\?sourceTime:CACurrentMediaTime\(\),macfx::layerComposesOpaquely\(metal\.layer\),/);
 assert.match(source,/pending->opaque=macfx::layerComposesOpaquely\(metal\.layer\);/);
 assert.match(source,/frame->opaque==macfx::layerComposesOpaquely\(layer\)&&/);
});
