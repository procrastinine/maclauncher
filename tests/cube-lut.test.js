const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Cube=require('../src/modules/shared/reshade/cube-lut'),Library=require('../src/modules/shared/reshade/filter-library'),Libplacebo=require('../src/modules/shared/reshade/libplacebo');
const identity='TITLE "identity"\nLUT_3D_SIZE 2\n'+Array.from({length:8},(_,i)=>`${i%2} ${Math.floor(i/2)%2} ${Math.floor(i/4)%2}`).join('\n');
test('CUBE retains red-fastest entries, independent domains and combined shaper ranges',()=>{
 const simple=Cube.parse(identity);assert.deepEqual(simple.rows[1],[1,0,0]);assert.deepEqual(simple.rows[4],[0,0,1]);
 const combined=Cube.parse('LUT_1D_SIZE 2\nLUT_3D_SIZE 2\nLUT_1D_INPUT_RANGE -1 1\nLUT_3D_INPUT_RANGE 0.25 2\n0 0 0\n1 1 1\n'+identity.split('\n').slice(2).join('\n'));
 assert.equal(combined.size1d,2);assert.deepEqual(combined.domain1d.minimum,[-1,-1,-1]);assert.deepEqual(combined.domain3d.maximum,[2,2,2]);
 const hook=Cube.hook(combined);assert.match(hook,/TEXTURE MLShaper/);assert.match(hook,/TEXTURE MLCube\n\/\/!SIZE 2 2 2/);assert.match(hook,/Tetrahedral/);assert.match(hook,/original\.rgb\/original\.a/);assert.match(hook,/c\*original\.a/);
});
test('CUBE rejects truncated entries, invalid ranges and shader precision overflow',()=>{
 for(const text of [identity+'\n0 0 0',identity.replace('1 0 0','NaN 0 0'),identity.replace('LUT_3D_SIZE 2','LUT_3D_SIZE 2\nDOMAIN_MIN 1 0 0\nDOMAIN_MAX 0 1 1'),identity.replace('LUT_3D_SIZE 2','LUT_3D_SIZE 2\nDOMAIN_MAX 1e300 1 1'),identity.replace('LUT_3D_SIZE 2','LUT_3D_SIZE 2\nDOMAIN_MIN 1 0 0\nDOMAIN_MAX 1.00000000001 1 1')])assert.throws(()=>Cube.parse(text));
});
test('CUBE preparation preserves the original and publishes one immutable reusable GPU texture hook',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cube-lut-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'original.cube');fs.writeFileSync(file,identity);const source=fs.readFileSync(file);
 const filters=Library.importFiles(root,[file]);assert.equal(filters[0].format,'libplacebo');assert.equal(filters[0].traits.rgbCompatible,true);
 const prepared=Cube.prepare(file,root);assert.equal(Cube.prepare(file,root),prepared);assert.equal(fs.statSync(prepared).mode&0o222,0);assert.deepEqual(fs.readFileSync(file),source);
 assert.match(prepared,/graphics\/luts\/1\/[a-f0-9]{64}\/effect\.hook$/);
 fs.chmodSync(prepared,0o644);fs.writeFileSync(prepared,'changed');assert.throws(()=>Cube.prepare(file,root),/prepared LUT changed/);assert.deepEqual(fs.readFileSync(file),source);
});
test('a 65-cube texture remains full resolution above the former 8 MiB shader limit',t=>{
 const rows=Array.from({length:65**3},()=>[0,0,0]);const hook=Cube.hook({size1d:0,size3d:65,rows,domain3d:{minimum:[0,0,0],maximum:[1,1,1]}});
 assert.ok(Buffer.byteLength(hook)>8*1024*1024);assert.ok(Buffer.byteLength(hook)<16*1024*1024);assert.match(hook,/SIZE 65 65 65/);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cube-65-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'full.hook');fs.writeFileSync(file,hook);assert.equal(Libplacebo.input(file),fs.realpathSync(file));
});
