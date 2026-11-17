const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const PE = require('../src/modules/shared/runtime/pe-exports');
const { peFixture } = require('./helpers/pe-fixture');
const denyExecution = () => assert.fail('PE table inspection must not execute a child or use the network');
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) require('node:child_process')[name] = denyExecution;
for (const id of ['http','https']) for (const name of ['request','get']) require('node:' + id)[name] = denyExecution;
globalThis.fetch = denyExecution;

// Authored PE tables only; these fixtures are read as data and never executed.
function image({ is64 = true, delayVa = false, normal = [], delay = [], exports = [], metadataBytes = 0x7400 } = {}) {
  const f = peFixture({ is64 }), bytes = Buffer.alloc(metadataBytes); f.bytes.copy(bytes);
  bytes.fill(0, f.raw); bytes.writeUInt16LE(0x2002, f.peOffset + 22);
  bytes.writeUInt16LE(2, f.peOffset + 6); bytes.write('.rdata\0\0', f.section);
  for (const offset of [8,16]) bytes.writeUInt32LE(bytes.length - f.raw, f.section + offset);
  bytes.writeUInt32LE(0x40000040, f.section + 36);
  const code = f.section + 40; bytes.write('.text\0\0\0', code);
  for (const [offset,value] of [[8,0x80],[12,0x1000],[16,0x80],[20,0x300],[36,0x60000020]]) bytes.writeUInt32LE(value, code + offset);
  const base = delayVa ? 0x10000000n : is64 ? 0x180000000n : 0x400000n;
  if (is64) bytes.writeBigUInt64LE(base, f.optional + 24); else bytes.writeUInt32LE(Number(base), f.optional + 28);
  const rva = offset => 0x2000 + offset, width = is64 ? 8 : 4;
  const writeThunk = (offset,value) => is64 ? bytes.writeBigUInt64LE(BigInt(value), f.raw + offset) : bytes.writeUInt32LE(Number(value), f.raw + offset);
  let next = Math.max(0x2000, 0x800 + (normal.length + 1) * 20, 0xc00 + (delay.length + 1) * 32);
  const string = text => {const start=next;next+=Buffer.byteLength(text)+1;bytes.write(text+'\0',f.raw+start);return rva(start);};
  const normalRows = [], delayRows = [];
  for (const [kind, rows, start, descriptorSize, result] of [['normal',normal,0x800,20,normalRows],['delay',delay,0xc00,32,delayRows]]) {
    if (!rows.length) continue;
    const directory = kind === 'normal' ? 1 : 13;
    bytes.writeUInt32LE(rva(start), f.directories + directory * 8); bytes.writeUInt32LE((rows.length+1)*descriptorSize,f.directories+directory*8+4);
    rows.forEach((row,i)=>{
      const lookup=next;next+=(row.symbols.length+1)*width;const iat=next;next+=(row.symbols.length+1)*width;
      const name=string(row.module),descriptor=f.raw+start+i*descriptorSize;
      const pointer=value=>kind==='delay'&&delayVa?Number(base)+value:value;
      if (kind==='normal') {
        bytes.writeUInt32LE(row.iatOnly ? 0 : rva(lookup),descriptor);bytes.writeUInt32LE(name,descriptor+12);bytes.writeUInt32LE(rva(iat),descriptor+16);
      } else {
        bytes.writeUInt32LE(delayVa?0:1,descriptor);bytes.writeUInt32LE(pointer(name),descriptor+4);bytes.writeUInt32LE(pointer(rva(iat)),descriptor+12);bytes.writeUInt32LE(row.iatOnly?0:pointer(rva(lookup)),descriptor+16);
      }
      row.symbols.forEach((symbol,index)=>{
        let value;
        if (typeof symbol==='number') value=(is64?0x8000000000000000n:0x80000000n)|BigInt(symbol);
        else {const hint=next;bytes.writeUInt16LE(symbol.hint||0,f.raw+next);next+=2;string(symbol.name);value=BigInt(kind==='delay'&&delayVa?Number(base)+rva(hint):rva(hint));}
        writeThunk(lookup+index*width,value);writeThunk(iat+index*width,value);
      });
      result.push({descriptor,lookup,iat,start,name});
    });
  }
  if (exports.length) {
    const baseOrdinal=Math.min(...exports.map(x=>x.ordinal)),count=Math.max(...exports.map(x=>x.ordinal))-baseOrdinal+1;
    bytes.writeUInt32LE(0x2100,f.directories);bytes.writeUInt32LE(0x600,f.directories+4);
    bytes.writeUInt32LE(baseOrdinal,f.raw+0x110);bytes.writeUInt32LE(count,f.raw+0x114);
    bytes.writeUInt32LE(exports.filter(x=>x.name).length,f.raw+0x118);
    for (const [offset,value] of [[0x11c,0x2180],[0x120,0x2280],[0x124,0x2300]]) bytes.writeUInt32LE(value,f.raw+offset);
    let named=0,forward=0x380;
    for (const row of exports) {
      let address=0x1010;
      if (row.forwarder) {address=rva(forward);bytes.write(row.forwarder+'\0',f.raw+forward);forward+=Buffer.byteLength(row.forwarder)+1;}
      bytes.writeUInt32LE(address,f.raw+0x180+(row.ordinal-baseOrdinal)*4);
      if (row.name) {bytes.writeUInt32LE(string(row.name),f.raw+0x280+named*4);bytes.writeUInt16LE(row.ordinal-baseOrdinal,f.raw+0x300+named*2);named++;}
    }
  }
  return {...f,bytes,normalRows,delayRows,width,rva,base};
}
function fixture(t,bytes) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pe-import-details-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'sample.dll');fs.writeFileSync(file,bytes);return file;
}

test('opt-in imports retain the DLL-name API and identify normal name/ordinal thunks for PE32 and PE32+',t=>{
  for(const is64 of [false,true]) {
    const f=image({is64,normal:[{module:'KERNEL32.dll',symbols:[{name:'GetProcAddress',hint:7},42]},{module:'api-ms-win-core-file-l1-2-0.dll',symbols:[{name:'CreateFileW'}]}]}),file=fixture(t,f.bytes);
    const old=PE.readPeExports(file,{imports:true}),parsed=PE.readPeExports(file,{importDetails:true});
    assert.deepEqual(parsed.peImports,old.peImports);assert.equal(parsed.importsComplete,true);assert.equal(parsed.importDetailsComplete,true);
    assert.deepEqual(parsed.peImportDetails,[{module:'kernel32.dll',kind:'normal',classification:'library',symbols:[{name:'GetProcAddress',hint:7},{ordinal:42}]},{module:'api-ms-win-core-file-l1-2-0.dll',kind:'normal',classification:'api-set',symbols:[{name:'CreateFileW',hint:0}]}]);
    assert.equal(Object.hasOwn(old,'peImportDetails'),false);assert.equal(Object.hasOwn(PE.readPeExports(file),'peImports'),false);
  }
});

test('normal imports can use the on-disk IAT when OriginalFirstThunk is zero',t=>{
  const file=fixture(t,image({normal:[{module:'ntdll.dll',iatOnly:true,symbols:[{name:'RtlExitUserThread'},3]}]}).bytes);
  const parsed=PE.readPeExports(file,{headersOnly:true,importDetails:true});
  assert.equal(parsed.importDetailsComplete,true);assert.deepEqual(parsed.peImportDetails[0].symbols,[{name:'RtlExitUserThread',hint:0},{ordinal:3}]);
});

test('delay imports decode both RVA and legacy VA descriptors without changing direct-DLL facts',t=>{
  for(const is64 of [false,true])for(const delayVa of [false,true]) {
    const f=image({is64,delayVa,normal:[{module:'dxgi.dll',symbols:[{name:'CreateDXGIFactory'}]}],delay:[{module:'ext-ms-win-test-l1-1-0.dll',symbols:[{name:'OptionalFunction',hint:5},11]}]}),file=fixture(t,f.bytes);
    const parsed=PE.readPeExports(file,{importDetails:true});assert.equal(parsed.importDetailsComplete,true);
    assert.deepEqual(parsed.peImports,['dxgi.dll']);assert.equal(parsed.importsComplete,false);assert.match(parsed.importWarning,/delay-import/);
    assert.deepEqual(parsed.peImportDetails[1],{module:'ext-ms-win-test-l1-1-0.dll',kind:'delay',classification:'api-set',symbols:[{name:'OptionalFunction',hint:5},{ordinal:11}]});
  }
});

test('ordinal export details retain ordinal-only slots, aliases and actual named/API-set/ordinal forwarders',t=>{
  const file=fixture(t,image({exports:[{ordinal:7,name:'Run'},{ordinal:8},{ordinal:9,name:'AliasA'},{ordinal:9,name:'AliasB'},{ordinal:10,name:'ForwardName',forwarder:'KERNELBASE.CreateFileW'},{ordinal:11,name:'ForwardOrdinal',forwarder:'NTDLL.#123'},{ordinal:12,name:'ForwardContract',forwarder:'api-ms-win-core-file-l1-2-0.CreateFileW'}]}).bytes);
  const basic=PE.readPeExports(file),parsed=PE.readPeExports(file,{exportOrdinals:true});
  assert.deepEqual(parsed.exports,basic.exports);assert.equal(Object.hasOwn(basic,'exportOrdinals'),false);assert.equal(parsed.exportOrdinals.size,6);
  assert.deepEqual(parsed.exportOrdinals.get(8).names,[]);assert.deepEqual(parsed.exportOrdinals.get(9).names,['AliasA','AliasB']);
  assert.deepEqual(parsed.exportOrdinals.get(10).forwarder,{module:'kernelbase.dll',classification:'library',name:'CreateFileW'});
  assert.deepEqual(parsed.exportOrdinals.get(11).forwarder,{module:'ntdll.dll',classification:'library',ordinal:123});
  assert.equal(parsed.exportOrdinals.get(12).forwarder.classification,'api-set');assert.equal(parsed.exportOrdinals.get(10).executable,false);
});

test('missing and empty import/export directories return complete empty optional detail',t=>{
  const parsed=PE.readPeExports(fixture(t,image().bytes),{importDetails:true,exportOrdinals:true});
  assert.equal(parsed.importDetailsComplete,true);assert.deepEqual(parsed.peImportDetails,[]);assert.equal(parsed.exportOrdinals.size,0);
});

test('sparse high-ordinal EAT slots have a separate bound from the named export count',t=>{
  const f=image({metadataBytes:0x24000}),count=28243,base=16,addresses=0x400,names=addresses+count*4,ordinals=names+8,strings=ordinals+4;
  f.bytes.writeUInt32LE(f.rva(0x100),f.directories);f.bytes.writeUInt32LE(strings+64-0x100,f.directories+4);
  for(const[offset,value]of [[16,base],[20,count],[24,2],[28,f.rva(addresses)],[32,f.rva(names)],[36,f.rva(ordinals)]])f.bytes.writeUInt32LE(value,f.raw+0x100+offset);
  for(const[index,name,stringOffset,n]of [[0,'D3DPERF_BeginEvent',strings,0],[count-1,'D3DPERF_EndEvent',strings+24,1]]){
    f.bytes.writeUInt32LE(0x1010,f.raw+addresses+index*4);f.bytes.writeUInt32LE(f.rva(stringOffset),f.raw+names+n*4);f.bytes.writeUInt16LE(index,f.raw+ordinals+n*2);f.bytes.write(name+'\0',f.raw+stringOffset);
  }
  const file=fixture(t,f.bytes),parsed=PE.readPeExports(file,{exportOrdinals:true});
  assert.equal(parsed.exports.get('D3DPERF_BeginEvent').executable,true);assert.equal(parsed.exportOrdinals.size,2);
  assert.deepEqual(parsed.exportOrdinals.get(base+count-1).names,['D3DPERF_EndEvent']);assert.equal(parsed.exportOrdinals.has(base+1),false);
  f.bytes.writeUInt32LE(PE.LIMITS.exportFunctions+1,f.raw+0x114);fs.writeFileSync(file,f.bytes);
  assert.equal(PE.readPeExports(file,{exportOrdinals:true}),null,'oversized EAT remains refused before reading its table');
});

test('malformed import detail refuses symbol closure while preserving legacy DLL facts',t=>{
  for(const [label,change] of [
    ['unbacked thunk',f=>f.bytes.writeUInt32LE(0xffffffff,f.normalRows[0].descriptor)],
    ['reserved ordinal bits',f=>f.bytes.writeBigUInt64LE(0x8000000000010001n,f.raw+f.normalRows[0].lookup)],
    ['64-bit by-name RVA overflow',f=>f.bytes.writeBigUInt64LE(0x100000000n,f.raw+f.normalRows[0].lookup)],
    ['unterminated thunk table',f=>{const offset=f.bytes.length-f.width;f.bytes.writeUInt32LE(f.rva(offset-f.raw),f.normalRows[0].descriptor);f.bytes.writeBigUInt64LE(0x8000000000000001n,offset);}],
    ['unbacked name RVA',f=>f.bytes.writeBigUInt64LE(0x7fffffffn,f.raw+f.normalRows[0].lookup)],
    ['missing IAT',f=>f.bytes.writeUInt32LE(0,f.normalRows[0].descriptor+16)],
    ['short IAT',f=>f.bytes.writeUInt32LE(0x8fff,f.normalRows[0].descriptor+16)],
  ]) {
    const f=image({normal:[{module:'kernel32.dll',symbols:[{name:'GetProcAddress'}]}]});change(f);
    const file=fixture(t,f.bytes),parsed=PE.readPeExports(file,{importDetails:true});
    assert.equal(parsed.importDetailsComplete,false,label);assert.match(parsed.importDetailsWarning,/PE/i,label);assert.deepEqual(parsed.peImportDetails,[],label);
    assert.deepEqual(PE.readPeExports(file,{imports:true}).peImports,['kernel32.dll'],label);
  }
});

test('malformed delay descriptors and legacy VAs do not produce guessed functions',t=>{
  for(const [label,change]of [
    ['attributes',f=>f.bytes.writeUInt32LE(3,f.delayRows[0].descriptor)],
    ['no terminator',f=>f.bytes.writeUInt32LE(32,f.directories+13*8+4)],
    ['invalid legacy VA',f=>{f.bytes.writeUInt32LE(0,f.delayRows[0].descriptor);f.bytes.writeUInt32LE(1,f.delayRows[0].descriptor+4);}],
  ]) {
    const f=image({delay:[{module:'optional.dll',symbols:[{name:'Later'}]}]});change(f);
    const parsed=PE.readPeExports(fixture(t,f.bytes),{importDetails:true});assert.equal(parsed.importDetailsComplete,false,label);assert.deepEqual(parsed.peImportDetails,[],label);
  }
});

test('descriptor and thunk budgets bound optional detail across all imported modules',t=>{
  const many=image({metadataBytes:0x20000,normal:Array.from({length:PE.LIMITS.importDescriptors+1},(_,i)=>({module:'module'+i+'.dll',symbols:[]}))});
  const descriptors=PE.readPeExports(fixture(t,many.bytes),{importDetails:true});assert.equal(descriptors.importDetailsComplete,false);assert.match(descriptors.importDetailsWarning,/descriptors exceed/);
  const thunks=image({metadataBytes:0x90000,normal:[{module:'large.dll',symbols:Array(PE.LIMITS.importThunks+1).fill(1)}]});
  const symbols=PE.readPeExports(fixture(t,thunks.bytes),{importDetails:true});assert.equal(symbols.importDetailsComplete,false);assert.match(symbols.importDetailsWarning,/thunks exceed/);
  assert.deepEqual(symbols.peImportDetails,[]);assert.ok(symbols.bytesRead<=PE.LIMITS.readBytes);
});

test('malformed forwarders refuse ordinal-detail inspection without changing legacy exports',t=>{
  for(const target of ['NoModuleSeparator','ntdll.#65536','ntdll.#bad','../ntdll.Run','kernel32.']) {
    const file=fixture(t,image({exports:[{ordinal:7,name:'Forward',forwarder:target}]}).bytes);
    assert.equal(PE.readPeExports(file,{exportOrdinals:true}),null,target);assert.equal(PE.readPeExports(file).exports.get('Forward').forwarded,true);
  }
});

test('truncated known PE metadata is refused and detection cancellation remains propagated',t=>{
  const file=fixture(t,image().bytes);fs.truncateSync(file,128);assert.equal(PE.readPeExports(file,{importDetails:true}),null);
  const original=fixture(t,image().bytes),error=Object.assign(Error('cancelled detection'),{code:'DETECTION_LIMIT'});
  assert.throws(()=>PE.readPeExports(original,{importDetails:true,detection:{stat:fs.statSync,readBytes(){throw error;}}}),value=>value===error);
});
