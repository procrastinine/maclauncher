const PARAMETERS = Object.freeze([
  {name:"iterations",label:"Iterations",type:"int",default:[1],min:0,max:4,step:1},
  {name:"threshold",label:"Threshold",type:"float",default:[3],min:0,max:64,step:0.1},
  {name:"radius",label:"Radius",type:"float",default:[16],min:1,max:64,step:1},
  {name:"grain",label:"Grain",type:"float",default:[4],min:0,max:16,step:0.1}
]);
function parse(text) {
  let value;try{value=JSON.parse(text);}catch{throw new Error("The libplacebo filter descriptor is invalid.");}
  if(!value||typeof value!=="object"||Array.isArray(value)||value.schema!==1||value.method!=="deband"||Object.keys(value).some(key=>!["schema","method"].includes(key)))
    throw new Error("The libplacebo filter descriptor is invalid.");
  return {schema:1,method:"deband",metadata:{schema:1,format:"libplacebo",imageFiltersAPI:1,method:"deband",parameters:PARAMETERS.map(row=>({...row,default:[...row.default]})),
    stages:["MAIN"],rgbCompatible:true,requiresDerivedPlanes:false,inputRepresentation:"rgb",requirements:{},
    traits:{category:"restoration",description:"libplacebo debanding and grain",neural:false,rgbCompatible:true,inputPlanes:["rgb"],geometryKnown:true,requestedOutputExtent:true,outputExtentEditable:true,sharedOnly:true,libplaceboImageFilter:"deband"},
    upstream:{name:"libplacebo",version:"7.360.1",url:"https://libplacebo.org/"}}};
}
function sourceAvailability(file,{features={}}={}) {
  if(features.providers?.libplacebo?.imageFiltersAPI===1)return null;
  let descriptor=/\.plfilter$/i.test(file);
  if(!descriptor){const fs=require("node:fs"),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const bytes=Buffer.alloc(4096),length=fs.readSync(fd,bytes,0,bytes.length,0);descriptor=bytes.subarray(0,length).toString("utf8").trimStart().startsWith("{");}finally{fs.closeSync(fd);}}
  return descriptor ? "This libplacebo image filter requires a graphics processor with image-filter support." : null;
}
module.exports={parse,sourceAvailability};
