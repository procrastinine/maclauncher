'use strict';
const {loadSources}=require('./index');
function tokens(source){return [...(source.interfaces?.requires||[]),...(source.assets||[]).flatMap(asset=>asset.interfaces?.requires||[])];}
function later(a,b){const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<Math.max(x.length,y.length);i++){if((x[i]||0)!==(y[i]||0))return(x[i]||0)>(y[i]||0)?a:b;}return a;}
function feature(source) {
 const requires=tokens(source),floors=requires.filter(token=>token.startsWith('macos>=')).map(token=>token.slice(7));
 if(!floors.length)return null;
 return {label:source.manager?.sectionLabel||source.label,platform:'darwin',minimumMacOS:floors.reduce(later),
  ...(requires.some(token=>['gpu:apple-physical','cpu:arm64','metal:4'].includes(token))?{hardwareArchitectures:['arm64']}:{})};
}
// Compatibility views for existing callers. Numeric requirements live only in
// source/asset/embed data; the resolver consumes the original tokens directly.
function byKind(kind){const result={};for(const source of loadSources().filter(s=>s.kind===kind)){const value=feature(source),engine=source.manager?.engine;if(value&&engine&&(!result[engine]||later(result[engine].minimumMacOS,value.minimumMacOS)===value.minimumMacOS))result[engine]=value;}return result;}
function engineFeature(kind,engine){return byKind(kind)[engine]||{};}
module.exports={tokens,feature,byKind,engineFeature};
