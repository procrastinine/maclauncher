import fs from "node:fs";
import {execFileSync} from "node:child_process";
// Namespace the private compiler ABI in owned copies. Instruction sections,
// wrapper functions, library identities and upstream files remain intact.
// Keep the shared first 's' of spirv_cross/simple_json export-tree edges.
// The complete loader export set below verifies the resulting namespace.
const exportsFor=file=>execFileSync("dyld_info",["-exports",file],{encoding:"utf8",maxBuffer:16*1024*1024}).split("\n").map(line=>/^\s*0x[0-9a-f]+\s+(\S+)/i.exec(line)?.[1]).filter(Boolean);
export function isolateCompiler(file,replacements){
  const renamed=name=>replacements.reduce((text,[from,to])=>text.replaceAll(from,to),name);
  const before=exportsFor(file),bytes=fs.readFileSync(file),slices=[];
  const magic=bytes.readUInt32BE(0);
  if(magic===0xcafebabe||magic===0xcafebabf){const wide=magic===0xcafebabf,count=bytes.readUInt32BE(4);if(count<1||count>8)throw Error("Invalid compiler architectures.");for(let n=0;n<count;n++){const at=8+n*(wide?32:20);slices.push(wide?Number(bytes.readBigUInt64BE(at+8)):bytes.readUInt32BE(at+8));}}
  else slices.push(0);
  for(const base of slices){
    if(bytes.readUInt32LE(base)!==0xfeedfacf)throw Error("The compiler must use a supported 64-bit Mach-O image.");
    const count=bytes.readUInt32LE(base+16),ranges=new Map(),tries=[];let at=base+32;
    const range=(offset,length)=>{if(!length)return;if(offset<0||length<0||base+offset+length>bytes.length)throw Error("Invalid compiler metadata range.");ranges.set(offset+":"+length,{offset:base+offset,length});};
    for(let n=0;n<count;n++){
      const kind=bytes.readUInt32LE(at),size=bytes.readUInt32LE(at+4);if(size<8||at+size>bytes.length)throw Error("Invalid compiler load command.");
      if(kind===2)range(bytes.readUInt32LE(at+16),bytes.readUInt32LE(at+20));
      if(kind===0x22||kind===0x80000022){for(const pair of [16,24,32,40])range(bytes.readUInt32LE(at+pair),bytes.readUInt32LE(at+pair+4));if(bytes.readUInt32LE(at+44))tries.push({offset:base+bytes.readUInt32LE(at+40),length:bytes.readUInt32LE(at+44)});}
      if(kind===0x80000033){const offset=bytes.readUInt32LE(at+8),length=bytes.readUInt32LE(at+12);range(offset,length);tries.push({offset:base+offset,length});}
      if(kind===0x80000034){const start=bytes.readUInt32LE(at+8),length=bytes.readUInt32LE(at+12),names=bytes.readUInt32LE(base+start+12);if(bytes.readUInt32LE(base+start+24)!==0)throw Error("Compressed compiler import names are unsupported.");range(start+names,length-names);}
      if(kind===0x19){const sections=bytes.readUInt32LE(at+64);for(let n=0;n<sections;n++){const section=at+72+n*80,name=bytes.toString("utf8",section,section+16).replace(/\0.*$/,"");if(name==="__cstring")range(bytes.readUInt32LE(section+48),Number(bytes.readBigUInt64LE(section+40)));}}
      at+=size;
    }
    const exportWrites=new Map();
    for(const {offset,length}of tries){
      const end=offset+length;let visits=0;
      const uleb=state=>{let value=0,scale=1;for(let n=0;n<8;n++){if(state.at>=end)throw Error("Invalid compiler export offset.");const next=bytes[state.at++];value+=(next&127)*scale;if(!(next&128))return value;scale*=128;}throw Error("Invalid compiler export integer.");};
      const walk=(relative,prefix,positions,ancestors)=>{if(++visits>200000||ancestors.has(relative)||relative<0||offset+relative>=end)throw Error("Invalid compiler export trie.");const state={at:offset+relative},terminal=uleb(state);if(state.at+terminal>=end)throw Error("Invalid compiler export terminal.");if(terminal){const target=renamed(prefix);if(target.length!==positions.length)throw Error("Compiler namespaces must preserve symbol length.");for(let n=0;n<positions.length;n++){const at=positions[n],value=target.charCodeAt(n);if(exportWrites.has(at)&&exportWrites.get(at)!==value)throw Error("Compiler namespace conflicts at shared export prefix: "+prefix);exportWrites.set(at,value);}}state.at+=terminal;const count=bytes[state.at++],nextAncestors=new Set(ancestors);nextAncestors.add(relative);for(let n=0;n<count;n++){const start=state.at;while(state.at<end&&bytes[state.at])state.at++;if(state.at===end)throw Error("Invalid compiler export edge.");const edge=bytes.toString("utf8",start,state.at),edgePositions=Array.from({length:state.at-start},(_value,index)=>start+index);state.at++;const child=uleb(state);walk(child,prefix+edge,positions.concat(edgePositions),nextAncestors);}};
      walk(0,"",[],new Set());
    }
    for(const {offset,length}of ranges.values()){const region=bytes.subarray(offset,offset+length);for(const [from,to]of replacements){if(from.length!==to.length)throw Error("Compiler namespaces must preserve byte length.");const source=Buffer.from(from),target=Buffer.from(to);let at=0;while((at=region.indexOf(source,at))!==-1){target.copy(region,at);at+=source.length;}}}
    for(const [at,value]of exportWrites)bytes[at]=value;
  }
  fs.writeFileSync(file,bytes);
  // Validate the loader's actual export trie as well as the symbol strings.
  // A compiler layout change must fail preparation rather than partly rename.
  const after=exportsFor(file),expected=before.map(renamed).sort(),actual=after.sort();if(JSON.stringify(expected)!==JSON.stringify(actual)||!before.some(name=>renamed(name)!==name)){const at=expected.findIndex((name,index)=>name!==actual[index]);throw Error("The compiler symbol namespace could not be isolated completely: "+file+" expected="+expected[at]+" actual="+actual[at]+" count="+before.length+"/"+after.length);}
  return {architectures:slices.length,exports:before.length};
}
