function parsed(bytes) {
  const valid=(at,size)=>Number.isSafeInteger(at)&&at>=0&&size>=0&&at+size<=bytes.length;
  if(!Buffer.isBuffer(bytes)||bytes.length<256||bytes.readUInt16LE(0)!==0x5a4d)throw Error("Invalid adapter PE image.");
  const pe=bytes.readUInt32LE(0x3c);if(!valid(pe,24)||bytes.readUInt32LE(pe)!==0x4550||bytes.readUInt16LE(pe+4)!==0x8664)throw Error("The adapter requires a 64-bit PE image.");
  const count=bytes.readUInt16LE(pe+6),optional=pe+24,optionalSize=bytes.readUInt16LE(pe+20),table=optional+optionalSize;
  if(!count||count>96||optionalSize<120||!valid(table,count*40)||bytes.readUInt16LE(optional)!==0x20b)throw Error("Invalid adapter PE sections.");
  const sections=Array.from({length:count},(_,index)=>{const at=table+index*40;return {at,virtualSize:bytes.readUInt32LE(at+8),address:bytes.readUInt32LE(at+12),rawSize:bytes.readUInt32LE(at+16),raw:bytes.readUInt32LE(at+20)};});
  const offset=(rva,size=1)=>{const section=sections.find(row=>rva>=row.address&&rva+size<=row.address+row.rawSize);if(!section||!valid(section.raw+rva-section.address,size))throw Error("Invalid adapter export address.");return section.raw+rva-section.address;};
  const exportRVA=bytes.readUInt32LE(optional+112),directory=offset(exportRVA,40),base=bytes.readUInt32LE(directory+16),functions=bytes.readUInt32LE(directory+20),names=bytes.readUInt32LE(directory+24);
  if(functions>65536||names>4096)throw Error("Invalid adapter export count.");
  const address=offset(bytes.readUInt32LE(directory+28),functions*4),namePointers=offset(bytes.readUInt32LE(directory+32),names*4),ordinals=offset(bytes.readUInt32LE(directory+36),names*2),byName=new Map();
  for(let i=0;i<names;++i){const nameAt=offset(bytes.readUInt32LE(namePointers+i*4)),end=bytes.indexOf(0,nameAt),ordinal=bytes.readUInt16LE(ordinals+i*2);if(end<nameAt||end-nameAt>512||ordinal>=functions)throw Error("Invalid adapter export name.");const name=bytes.toString('ascii',nameAt,end);if(!/^[A-Za-z_]\w*$/.test(name)||byName.has(name))throw Error("Invalid adapter export symbol.");byName.set(name,{ordinal:base+ordinal,address:bytes.readUInt32LE(address+ordinal*4)});}
  return {pe,optional,table,count,sections,byName,valid};
}

/** Derive only an owned adapter's export table. The game and sealed template
 * remain untouched. Code addresses bind by symbol; the original DLL supplies
 * its exact name/ordinal profile, including gaps and older public ordinals. */
function bind(template,profile) {
  const image=parsed(template);
  if(!Array.isArray(profile)||!profile.length||profile.length>4096||profile.some(row=>!row||!/^[A-Za-z_]\w*$/.test(row.name)||!Number.isInteger(row.ordinal)||row.ordinal<1||row.ordinal>65535)||new Set(profile.map(row=>row.name)).size!==profile.length)throw Error("Invalid XeSS export profile.");
  const fallback=image.byName.get("xessStartDump");if(!fallback)throw Error("The adapter does not define its unsupported-extension entry.");
  for(const name of ["xessD3D11CreateContext","xessD3D11Init","xessD3D11Execute","xessDestroyContext"])if(!profile.some(row=>row.name===name))throw Error("The source does not expose the XeSS D3D11 API.");
  const align=(size,unit)=>Math.ceil(size/unit)*unit,fileAlignment=template.readUInt32LE(image.optional+36),sectionAlignment=template.readUInt32LE(image.optional+32),headers=template.readUInt32LE(image.optional+60);
  if(!fileAlignment||!sectionAlignment||image.table+(image.count+1)*40>headers)throw Error("The adapter PE header cannot accommodate its export profile.");
  const rows=[...profile].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),base=Math.min(...rows.map(row=>row.ordinal)),functions=Math.max(...rows.map(row=>row.ordinal))-base+1;
  const functionAt=40,nameAt=functionAt+functions*4,ordinalAt=nameAt+rows.length*4,stringsAt=ordinalAt+rows.length*2;
  const library=Buffer.from("libxess_dx11.dll\0"),strings=rows.map(row=>Buffer.from(row.name+'\0'));
  const size=stringsAt+library.length+strings.reduce((total,row)=>total+row.length,0),rawSize=align(size,fileAlignment),raw=align(template.length,fileAlignment);
  const address=align(Math.max(...image.sections.map(row=>row.address+Math.max(row.virtualSize,row.rawSize))),sectionAlignment),data=Buffer.alloc(rawSize);
  data.writeUInt32LE(address+stringsAt,12);data.writeUInt32LE(base,16);data.writeUInt32LE(functions,20);data.writeUInt32LE(rows.length,24);data.writeUInt32LE(address+functionAt,28);data.writeUInt32LE(address+nameAt,32);data.writeUInt32LE(address+ordinalAt,36);library.copy(data,stringsAt);
  let cursor=stringsAt+library.length;
  const targets=new Map();
  for(const row of rows){const known=image.byName.get(row.name),prior=targets.get(row.ordinal);if(known&&prior?.known&&prior.address!==known.address)throw Error("The source aliases incompatible XeSS functions to one ordinal.");if(known||!prior)targets.set(row.ordinal,{address:(known||fallback).address,known:Boolean(known)});}
  for(const [ordinal,target] of targets)data.writeUInt32LE(target.address,functionAt+(ordinal-base)*4);
  rows.forEach((row,index)=>{data.writeUInt32LE(address+cursor,nameAt+index*4);data.writeUInt16LE(row.ordinal-base,ordinalAt+index*2);strings[index].copy(data,cursor);cursor+=strings[index].length;});
  const output=Buffer.alloc(raw+rawSize);template.copy(output);data.copy(output,raw);
  const section=image.table+image.count*40;output.write('.mlxp',section,'ascii');output.writeUInt32LE(size,section+8);output.writeUInt32LE(address,section+12);output.writeUInt32LE(rawSize,section+16);output.writeUInt32LE(raw,section+20);output.writeUInt32LE(0x40000040,section+36);
  output.writeUInt16LE(image.count+1,image.pe+6);output.writeUInt32LE(align(address+size,sectionAlignment),image.optional+56);output.writeUInt32LE(output.readUInt32LE(image.optional+8)+rawSize,image.optional+8);output.writeUInt32LE(address,image.optional+112);output.writeUInt32LE(size,image.optional+116);
  // Parse the produced bytes directly as the final structural check.
  const rebound=parsed(output).byName;
  if(profile.some(row=>rebound.get(row.name)?.ordinal!==row.ordinal))throw Error("The derived XeSS export profile changed.");
  return output;
}
function inspect(file){try{const fs=require("node:fs"),stat=fs.statSync(file);if(!stat.isFile()||stat.size>32*1024*1024)return null;return [...parsed(fs.readFileSync(file)).byName].map(([name,row])=>({name,ordinal:row.ordinal})).sort((a,b)=>a.ordinal-b.ordinal||a.name.localeCompare(b.name));}catch{return null;}}
module.exports={bind,parsed,inspect};
