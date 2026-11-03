const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { prepare } = require('../src/modules/catsystem2/runtime/stage-cp932.cjs');
function fixture(t, bytes = Buffer.from('table')) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cp932-preparation-'));
  t.after(()=>fs.rmSync(repoRoot,{recursive:true,force:true}));
  const directory=path.join(repoRoot,'src/modules/catsystem2/resources/encoding');fs.mkdirSync(directory,{recursive:true});
  const manifest={sourceUrl:'https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WINDOWS/CP932.TXT',tableBytes:bytes.length,tableSha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  fs.writeFileSync(path.join(directory,'cp932.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(directory,'Unicode-LICENSE.txt'),'fixture');
  return{repoRoot,directory,bytes};
}
test('CP932 setup reuses valid generated data without network or rewrites',async t=>{
  const f=fixture(t),file=path.join(f.directory,'cp932.bin');fs.writeFileSync(file,f.bytes);const before=fs.statSync(file);
  const result=await prepare({repoRoot:f.repoRoot,download:()=>assert.fail('Valid table stays offline')});
  assert.equal(result.generated,false);assert.equal(fs.statSync(file).mtimeMs,before.mtimeMs);
});
test('CP932 setup rejects changed publisher text and preserves existing data atomically',async t=>{
  const f=fixture(t),file=path.join(f.directory,'cp932.bin');fs.writeFileSync(file,'previous data');let requests=0;
  await assert.rejects(prepare({repoRoot:f.repoRoot,download:async(url,target)=>{requests++;assert.match(url,/unicode.org/);fs.writeFileSync(target,'changed publisher source');}}),/pinned CP932 data source changed/);
  assert.equal(requests,1);assert.equal(fs.readFileSync(file,'utf8'),'previous data');
  assert.deepEqual(fs.readdirSync(f.directory).sort(),['Unicode-LICENSE.txt','cp932.bin','cp932.json']);
});
