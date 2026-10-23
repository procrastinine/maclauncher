const fs=require('node:fs');
const path=require('node:path');

/** Fixture layouts come from the exact original declarations consumed by the
 * component. No interface field order or guest record size is repeated here. */
function writeShapes(directory,output){
  const guest=JSON.parse(fs.readFileSync(path.join(directory,'guest-ast.json')));
  const record=name=>{
    let value=guest.types[name];
    while(value?.kind==='Pointer')value=guest.types[value.element];
    if(value?.kind!=='Record')throw Error('Fixture requires original record '+name);
    return value;
  };
  const objects=record('SLObjectItf'),engine=record('SLEngineItf'),addresses=record('struct addrinfo'),vector=record('struct iovec');
  const field=(value,name)=>{const f=value.fields.find(f=>f.name===name);if(!f||f.offset<0||f.offset%8)throw Error('Original field layout is unavailable: '+name);return f.offset/8;};
  const values={objectBytes:objects.size,objectRealize:field(objects,'Realize'),objectState:field(objects,'GetState'),objectQuery:field(objects,'GetInterface'),objectDestroy:field(objects,'Destroy'),engineBytes:engine.size,engineOutputMix:field(engine,'CreateOutputMix'),addressNext:field(addresses,'ai_next'),vectorBytes:vector.size,vectorBase:field(vector,'iov_base'),vectorLength:field(vector,'iov_len')};
  const host=JSON.parse(fs.readFileSync(path.join(directory,'host-ast.json')));
  values.allocationAlignment=host.types.max_align_t.alignment;
  for(const family of ['SL','XA'])for(const [suffix,name,fields]of [['Object','ObjectItf',['GetInterface']],['Engine','EngineItf',['CreateOutputMix']]]){
    const dereference=(declarations,type)=>{let value=declarations.types[type];while(value?.kind==='Pointer')value=declarations.types[value.element];return value;};
    const original=dereference(guest,family+name),native=dereference(host,family+name);
    values[family+suffix+'Bytes']=original.size;values[family+suffix+'HostBytes']=native.size;
    for(const name of fields){values[family+suffix+name]=field(original,name);values[family+suffix+name+'Host']=field(native,name);}
  }
  fs.writeFileSync(path.join(output,'imports-shapes.h'),'#pragma once\nnamespace shapes {\n'+Object.entries(values).map(([name,value])=>`inline constexpr unsigned ${name}=${value};`).join('\n')+'\n}\n');
  return values;
}
module.exports={writeShapes};
