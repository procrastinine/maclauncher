const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('clipboard gestures survive IPC latency once, with exact foreground and process lifetime',t=>{
 if(process.platform!=='darwin')return t.skip('Requires macOS');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-clipboard-gesture-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'gesture.cpp'),binary=path.join(root,'gesture');
 fs.writeFileSync(source,`#include "${path.resolve('src/modules/android/native/clipboard-gesture.h')}"
#include <cassert>
int main(){
 KLClipboardGestures g;g.enroll(123);
 g.sample(123,true,false,false,false,0);g.sample(123,true,false,false,true,.1);
 g.sample(123,false,false,false,false,.15);
 assert(!g.consume(124,123,false,.3));assert(!g.consume(123,124,false,.3));
 assert(!g.consume(123,123,true,.3));assert(g.consume(123,123,false,.3));assert(!g.consume(123,123,false,.3));
 g.sample(123,true,true,true,false,.4);assert(!g.consume(123,123,true,.5));
 g.sample(123,false,false,false,false,.6);g.sample(123,true,false,true,false,.7);
 assert(!g.consume(123,123,true,3));
 g.sample(124,true,false,false,true,4);g.sample(123,true,false,false,true,4.1);assert(!g.consume(123,123,false,4.2));
 g.sample(123,false,false,false,false,4.3);g.sample(123,true,false,false,true,4.4);
 g.retire(123);g.enroll(123);assert(!g.consume(123,123,false,4.5));
 g.sample(123,true,false,false,true,4.6);assert(!g.consume(123,123,false,4.7));
}
`);
 let result=spawnSync('clang++',['-std=c++20',source,'-o',binary],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 result=spawnSync(binary,[],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const helper=path.join(root,'android-clipboard');
 result=spawnSync('clang++',['-std=c++20','-fobjc-arc','-mmacosx-version-min=13.0',path.resolve('src/modules/android/native/clipboard-gesture.mm'),'-framework','AppKit','-framework','Carbon','-framework','CoreGraphics','-o',helper],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const requests=[{op:'enroll',pid:2147483647},{op:'transfer',id:'1',pid:2147483647,operation:'paste'},{op:'transfer',id:'2',pid:0,operation:'copy',text:'fixture'},{op:'retire',pid:2147483647},{op:'transfer',id:'3',pid:2147483647,operation:'paste'}];
 result=spawnSync(helper,[],{input:requests.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:3000});assert.equal(result.status,0,result.stderr);
 assert.deepEqual(result.stdout.trim().split('\n').map(JSON.parse),['1','2','3'].map(id=>({id,allowed:false})));
});
