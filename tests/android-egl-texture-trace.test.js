const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
test('GLES texture diagnostics preserve original arguments, direct disabled dispatch and bounded metadata',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-texture-trace-'));
 try{
  const binary=path.join(root,'probe');
  execFileSync('clang++',['-std=c++20','-pthread','-I'+path.resolve('src/modules/android/native'),path.resolve('tests/fixtures/android-native/egl-texture-trace.cpp'),'-o',binary]);
  const off=execFileSync(binary,['off'],{encoding:'utf8'});assert.match(off,/PASS disabled diagnostics/);
  const {spawnSync}=require('node:child_process'),on=spawnSync(binary,['on'],{encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(on.status,0,on.stderr);
  assert.match(on.stdout,/PASS texture metadata forwarding/);assert.match(on.stderr,/op=glTexImage2D target=0xde1 texture=73 level=2 format=0x1908 pixels=476x88/);
  assert.equal(on.stderr.split('\n').filter(line=>line.includes('event=')).length,8192);assert.match(on.stderr,/metadata limit reached/);
  const shaders=spawnSync(binary,['shaders'],{encoding:'utf8',maxBuffer:1024*1024});assert.equal(shaders.status,0,shaders.stderr);
  assert.match(shaders.stdout,/PASS native shader diagnostics/);assert.match(shaders.stderr,/op=glCompileShader object=17 log=original compiler diagnostic source=original native shader source/);assert.match(shaders.stderr,/op=glLinkProgram object=15/);
  assert.equal(shaders.stderr.split('\n').filter(line=>line.startsWith('[android-gl-shader]')).length,16);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
