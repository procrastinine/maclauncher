// Copyright (c) MacLauncher contributors. MIT license.
const ARCHITECTURES=Object.freeze({
  'realesrgan.srvgg-16.x4.v1':{method:'realesrgan',scale:4,depth:16},
  'realesrgan.srvgg-32.x4.v1':{method:'realesrgan',scale:4,depth:32},
  'rife.v4.6.ncnn.v1':{method:'rife',scale:1},
  'realcugan.upcunet2x.v1':{method:'realcugan',scale:2},
  'realcugan.upcunet3x.v1':{method:'realcugan',scale:3},
  'realcugan.upcunet4x.v1':{method:'realcugan',scale:4},
  'nafnet.sidd-width64.v1':{method:'nafnet',scale:1,encoders:[2,2,4,8],decoders:[2,2,2,2],middle:12},
  'nafnet.gopro-width64.tlc.v1':{method:'nafnet',scale:1,encoders:[1,1,1,28],decoders:[1,1,1,1],middle:1}
});
function shapes(architecture){
  const spec=ARCHITECTURES[architecture];if(!spec)return null;
  if(spec.method==='rife'){
    const out={},conv=(n,i,o,k=3)=>{out[n+'.weight']=[o,k,k,i];out[n+'.bias']=[o];};[192,128,96,64].forEach((c,s)=>{conv(`convrelu_${s*2}`,s?12:7,c/2);conv(`convrelu_${s*2+1}`,c/2,c);for(let i=0;i<8;i++)conv(`conv_${22+s*10+i}`,c,c);conv(`deconv_${60+s}`,c,24,4);});return out;
  }
  if(spec.method==='realcugan'){
    const out={},conv=(n,i,o,k)=>{out[n+'.weight']=[o,k,k,i];out[n+'.bias']=[o];},block=(n,i,m,o,se)=>{conv(n+'.conv.0',i,m,3);conv(n+'.conv.2',m,o,3);if(se){conv(n+'.seblock.conv1',o,o/8,1);conv(n+'.seblock.conv2',o/8,o,1);}};
    const channels=spec.scale===4?64:3;
    block('unet1.conv1',3,32,64,false);conv('unet1.conv1_down',64,64,2);block('unet1.conv2',64,128,64,true);conv('unet1.conv2_up',64,64,2);conv('unet1.conv3',64,64,3);conv('unet1.conv_bottom',64,channels,spec.scale===3?5:4);
    block('unet2.conv1',channels,32,64,false);conv('unet2.conv1_down',64,64,2);block('unet2.conv2',64,64,128,true);conv('unet2.conv2_down',128,128,2);block('unet2.conv3',128,256,128,true);conv('unet2.conv3_up',128,128,2);block('unet2.conv4',128,64,64,true);conv('unet2.conv4_up',64,64,2);conv('unet2.conv5',64,64,3);conv('unet2.conv_bottom',64,channels,3);if(spec.scale===4)conv('conv_final',64,12,3);return out;
  }
  if(spec.method==='nafnet'){
    const out={},conv=(n,i,o,k=1,b=true,g=1)=>{out[n+'.weight']=[o,k,k,i/g];if(b)out[n+'.bias']=[o];},block=(n,c)=>{
      conv(n+'.conv1',c,c*2);conv(n+'.conv2',c*2,c*2,3,true,c*2);conv(n+'.conv3',c,c);conv(n+'.sca',c,c);conv(n+'.conv4',c,c*2);conv(n+'.conv5',c,c);
      for(const a of ['norm1','norm2']){out[n+'.'+a+'.weight']=[c];out[n+'.'+a+'.bias']=[c];}for(const a of ['beta','gamma'])out[n+'.'+a]=[1,1,1,c];
    };conv('intro',3,64,3);conv('ending',64,3,3);let c=64;
    spec.encoders.forEach((count,s)=>{for(let i=0;i<count;i++)block(`encoders.${s}.${i}`,c);conv(`downs.${s}`,c,c*2,2);c*=2;});for(let i=0;i<spec.middle;i++)block(`middle_blks.${i}`,c);
    spec.decoders.forEach((count,s)=>{conv(`ups.${s}`,c,c*2,1,false);c/=2;for(let i=0;i<count;i++)block(`decoders.${s}.${i}`,c);});return out;
  }
  const result={};for(let i=0;i<=spec.depth;++i){result[`body.${2*i}.weight`]=[64,3,3,i?64:3];result[`body.${2*i}.bias`]=[64];result[`body.${2*i+1}.weight`]=[64];}
  result[`body.${2*spec.depth+2}.weight`]=[48,3,3,64];result[`body.${2*spec.depth+2}.bias`]=[48];return result;
}
function matches(architecture,values){
  const expected=shapes(architecture);if(!expected||!Array.isArray(values))return false;
  const actual=new Map(values.map(row=>[row.name,row]));return actual.size===Object.keys(expected).length&&values.length===actual.size&&Object.entries(expected).every(([name,shape])=>JSON.stringify(actual.get(name)?.shape)===JSON.stringify(shape)&&(ARCHITECTURES[architecture].method==='nafnet'?actual.get(name)?.dataType==='float32':['float16','float32'].includes(actual.get(name)?.dataType)));
}
function contract(value){
  const spec=ARCHITECTURES[value?.architecture];if(!spec)return false;
  const input=value.inputs?.[0],output=value.outputs?.[0],shape=input?.shape;
  if(spec.method==='rife')return value.inputs?.length===2&&value.outputs?.length===1&&value.inputs.every(row=>row.layout==='nhwc'&&JSON.stringify(row.shape)===JSON.stringify([1,'height','width',3]))&&output.layout==='nhwc'&&JSON.stringify(output.shape)===JSON.stringify([1,'height','width',3]);
  return value.inputs?.length===1&&value.outputs?.length===1&&input.layout==='nhwc'&&output.layout==='nhwc'&&shape?.length===4&&shape[0]===1&&shape[3]===3&&typeof shape[1]==='string'&&typeof shape[2]==='string'&&
    JSON.stringify(output.shape)===JSON.stringify(spec.scale===1?shape:[1,{symbol:shape[1],multiplier:spec.scale},{symbol:shape[2],multiplier:spec.scale},3]);
}
module.exports={ARCHITECTURES,shapes,matches,contract};
