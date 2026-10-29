#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2009-2011 Computer Graphics Systems Group, Hasso-Plattner-Institut, Potsdam.
// Shader interface and static sector-table adaptation of Jan Eric Kyprianidis's gpuakf.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=import.meta.dirname,spec=JSON.parse(fs.readFileSync(path.join(here,'source.json'))),args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--source'||args[2]!=='--output')throw Error('Expected --source and --output directories.');
const source=path.resolve(args[1]),output=path.resolve(args[3]),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
if(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==spec.commit)throw Error('The Kuwahara source revision differs from its declared pin.');
execFileSync('git',['-C',source,'diff','--exit-code','HEAD','--']);
const inputs={};for(const [file,digest]of Object.entries(spec.files)){
 const bytes=fs.readFileSync(path.join(source,file));if(hash(bytes)!==digest)throw Error('The Kuwahara source changed: '+file);inputs[file]=bytes.toString('utf8').replaceAll('\r\n','\n');
}
// Original make_sector/gauss_filter: four 32x32 sectors, eight-way symmetry,
// sigma_r=(size-1)/4 and the original 33.33% sector smoothing default.
const size=32,sigmaR=(size-1)/4,sigmaS=0.3333*sigmaR,sectors=[];
for(let k=0;k<4;k++){
 const mask=new Float32Array(size*size),table=new Float32Array(size*size),radius=Math.ceil(2*sigmaS),twoSigma2=2*sigmaS*sigmaS;
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const px=x-size/2+.5,py=y-size/2+.5;let angle=.5*Math.atan2(py,px)/Math.PI+k/8;
  if(angle>.5)angle--;if(angle<-.5)angle++;mask[y*size+x]=Math.abs(angle)<=1/16&&Math.hypot(px,py)<size/2?1:0;
 }
 let maximum=0;for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  let sum=0,norm=0;for(let i=-radius;i<=radius;i++)for(let j=-radius;j<=radius;j++){
   const sx=x+i,sy=y+j;if(sx<0||sy<0||sx>=size||sy>=size)continue;
   const weight=Math.fround(Math.exp(-(i*i+j*j)/twoSigma2));norm=Math.fround(norm+weight);sum=Math.fround(sum+Math.fround(weight*mask[sy*size+sx]));
  }
  const px=x-size/2+.5,py=y-size/2+.5,value=Math.fround(Math.fround(sum/norm)*Math.exp(-.5*(px*px+py*py)/(sigmaR*sigmaR)));
  table[y*size+x]=value;maximum=Math.max(maximum,value);
 }for(let i=0;i<table.length;i++)table[i]=Math.fround(table[i]/maximum);sectors.push(table);
}
// One zero texel around the table reproduces GL_CLAMP_TO_BORDER's linear
// border without requiring a nonportable sampler mode in the hook provider.
const dimension=size+2,kernel=Buffer.alloc(dimension*dimension*4*4);
for(let y=0;y<size;y++)for(let x=0;x<size;x++)for(let k=0;k<4;k++)kernel.writeFloatLE(sectors[k][y*size+x],((y+1)*dimension+x+1)*16+k*4);
const params=`//!PARAM Radius
//!DESC Radius
//!TYPE float
//!MINIMUM 1
//!MAXIMUM 20
3
//!PARAM Sharpness
//!DESC Sharpness
//!TYPE float
//!MINIMUM 1
//!MAXIMUM 16
8
//!PARAM Anisotropy
//!DESC Anisotropy
//!TYPE float
//!MINIMUM 0
//!MAXIMUM 4
1
//!PARAM Smoothing
//!DESC Orientation smoothing
//!TYPE float
//!MINIMUM 0
//!MAXIMUM 5
2
`;
function body(file){const text=inputs[file],match=/void main\s*\(void\)\s*\{([\s\S]*)\}\s*$/.exec(text);if(!match)throw Error('The original Kuwahara entry changed: '+file);return match[1];}
const straight=`vec4 mlSource(vec2 p){vec4 c=HOOKED_tex(p);return vec4(c.a>0.0?c.rgb/c.a:vec3(0.0),c.a);}`;
const tensor=body('glsl/sst.glsl').replace('vec2(textureSize2D(src, 0))','HOOKED_size').replaceAll('gl_FragCoord.xy','HOOKED_pos * HOOKED_size').replaceAll('texture2D(src,','mlSource(').replace('gl_FragColor =','return');
const orientation=body('glsl/tfm.glsl').replace('gl_FragCoord.xy / vec2(textureSize2D(src, 0))','AKF_SMOOTH_Y_pos').replaceAll('texture2D(src,','AKF_SMOOTH_Y_tex(').replace('gl_FragColor =','return');
let filter=body('glsl/akf_v2.glsl').replace('vec2(textureSize2D(src, 0))','HOOKED_size').replaceAll('gl_FragCoord.xy','HOOKED_pos * HOOKED_size').replaceAll('texture2D(src,','mlSource(').replaceAll('texture2D(tfm,','AKF_ORIENTATION_tex(').replaceAll('texture2D(K0123,','mlKernel(').replaceAll(/\bradius\b/g,'Radius').replaceAll(/\bq\b/g,'Sharpness').replaceAll(/\balpha\b/g,'1.0');
filter=filter.replace('vec4 t = AKF_ORIENTATION_tex( uv);','vec4 t = AKF_ORIENTATION_tex( uv);\n    t.w *= Anisotropy;');
if(!filter.includes('t.w *= Anisotropy;'))throw Error('The original Kuwahara orientation contract changed.');
// The original normalized weights are unchanged mathematically. Evaluate their
// logarithms, then remove a common scale before summing: pow can overflow for
// HDR variance/high sharpness even when the final weighted mean is finite.
const originalWeights=`    vec4 o = vec4(0.0);
    for (int k = 0; k < N; ++k) {
        m[k].rgb /= m[k].w;
        s[k] = abs(s[k] / m[k].w - m[k].rgb * m[k].rgb);

        float sigma2 = s[k].r + s[k].g + s[k].b;
        float w = 1.0 / (1.0 + pow(255.0 * sigma2, 0.5 * Sharpness));

        o += vec4(m[k].rgb * w, w);
    }`;
if(!filter.includes(originalWeights))throw Error('The original Kuwahara weight contract changed.');
filter=filter.replace(originalWeights,`    float logWeights[8];
    float maximumLogWeight = -3.402823e38;
    for (int k = 0; k < N; ++k) {
        m[k].rgb /= m[k].w;
        s[k] = abs(s[k] / m[k].w - m[k].rgb * m[k].rgb);
        float sigma2 = s[k].r + s[k].g + s[k].b;
        float exponent = 0.5 * Sharpness * log(max(255.0 * sigma2, 1e-30));
        logWeights[k] = -max(exponent, 0.0) - log(1.0 + exp(-abs(exponent)));
        maximumLogWeight = max(maximumLogWeight, logWeights[k]);
    }
    vec4 o = vec4(0.0);
    for (int k = 0; k < N; ++k) {
        float w = exp(logWeights[k] - maximumLogWeight);
        o += vec4(m[k].rgb * w, w);
    }`);
filter=filter.replace('gl_FragColor =  vec4(o.rgb / o.w, 1.0);','vec4 original = HOOKED_tex(HOOKED_pos);\n    return vec4((o.rgb / o.w) * original.a, original.a);');
if(filter.includes('gl_FragColor'))throw Error('The original Kuwahara output contract changed.');
function smooth(name,input,axis){return `//!HOOK MAIN
//!DESC Anisotropic Kuwahara tensor smoothing
//!BIND ${input}
//!SAVE ${name}
//!COMPONENTS 4
vec4 hook(){float sigma=Smoothing;int halfWidth=int(ceil(2.0*sigma));vec3 sum=vec3(0.0);float norm=0.0;
 if(halfWidth==0)return ${input}_tex(${input}_pos);
 for(int i=-halfWidth;i<=halfWidth;i++){float w=exp(-float(i*i)/(2.0*sigma*sigma));sum+=${input}_tex(${input}_pos+${axis}*float(i)).rgb*w;norm+=w;}
 return vec4(sum/norm,1.0);}
`;}
const shader=`// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2009-2011 Computer Graphics Systems Group, Hasso-Plattner-Institut, Potsdam.
// Adapted from gpuakf by Jan Eric Kyprianidis. See source-files.json and LICENSE.
// Structure tensor, separable Gaussian, eigenframe and original eight-sector AKF v2.
${params}
//!TEXTURE AKF_KERNEL
//!SIZE ${dimension} ${dimension}
//!FORMAT rgba16f
//!FILTER LINEAR
//!BORDER CLAMP
${kernel.toString('hex')}

//!HOOK MAIN
//!DESC Anisotropic Kuwahara structure tensor
//!BIND HOOKED
//!SAVE AKF_TENSOR
//!COMPONENTS 4
${straight}
vec4 hook(){${tensor}}

${smooth('AKF_SMOOTH_X','AKF_TENSOR','vec2(AKF_TENSOR_pt.x,0.0)')}
${smooth('AKF_SMOOTH_Y','AKF_SMOOTH_X','vec2(0.0,AKF_SMOOTH_X_pt.y)')}
//!HOOK MAIN
//!DESC Anisotropic Kuwahara orientation
//!BIND AKF_SMOOTH_Y
//!SAVE AKF_ORIENTATION
//!COMPONENTS 4
vec4 hook(){${orientation}}

//!HOOK MAIN
//!DESC Anisotropic Kuwahara
//!BIND HOOKED
//!BIND AKF_ORIENTATION
//!BIND AKF_KERNEL
${straight}
vec4 mlKernel(vec2 p){return AKF_KERNEL_tex((p*32.0+1.0)/34.0);}
const float PI=3.14159265358979323846;const int N=8;
vec4 hook(){${filter}}
`;
fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'anisotropic-kuwahara.hook'),shader);fs.copyFileSync(path.join(source,'LICENSE'),path.join(output,'LICENSE'));
fs.writeFileSync(path.join(output,'source-files.json'),JSON.stringify({schema:1,repository:spec.repository,revision:spec.commit,license:'GPL-3.0-or-later',sources:spec.files,adaptation:['Five GPU passes with separable equivalent Gaussian smoothing','Original 32x32 smoothed sector kernel with exact zero border','Premultiplied alpha boundary, original alpha retained','Anisotropy control equals inverse original alpha','Equivalent log-domain sector-weight normalization prevents overflow and underflow'],files:{'anisotropic-kuwahara.hook':hash(shader),LICENSE:hash(fs.readFileSync(path.join(output,'LICENSE')))},owned:{'build.mjs':hash(fs.readFileSync(path.join(here,'build.mjs'))),'source.json':hash(fs.readFileSync(path.join(here,'source.json')))}},null,2)+'\n');
console.log('Built anisotropic Kuwahara shader collection: '+output);
