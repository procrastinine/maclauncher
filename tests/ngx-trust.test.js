const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Trust=require('../src/modules/crossover/temporal/ngx-trust');
test('legacy NGX packages start without certificate work',async()=>{
 assert.equal(Trust.prepare({}),null);
 await Trust.apply(null,{assertWritable(){throw Error('unused');},run(){throw Error('unused');}});
});
test('certificate preparation rejects paths outside the verified package before Wine starts',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ngx-trust-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 assert.throws(()=>Trust.prepare({root,manifest:{ngxTrust:{certificate:'../certificate.der',helper:'helper.exe'}}}),/path|relative/i);
 fs.symlinkSync('/etc/hosts',path.join(root,'certificate.der'));
 assert.throws(()=>Trust.prepare({root,manifest:{ngxTrust:{certificate:'certificate.der',helper:'helper.exe'}}}),/regular/);
});
test('trust setup preserves the prefix write guard and checks the actual selected core',async()=>{
 const trust={helper:'/package/x64/ngx-trust.exe',certificate:'/package/ngx-signing/certificate.der',core:'/package/x64/nvngx.dll'},calls=[];
 await assert.rejects(Trust.apply(trust,{assertWritable(){throw Error('aliased registry');},run(){throw Error('must not run');}}),/aliased registry/);
 await Trust.apply(trust,{assertWritable(){calls.push('guard');},run(args){calls.push(args);}});
 assert.deepEqual(calls,['guard',['Z:\\package\\x64\\ngx-trust.exe','install','Z:\\package\\ngx-signing\\certificate.der','Z:\\package\\x64\\nvngx.dll']]);
});
