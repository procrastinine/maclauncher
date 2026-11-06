// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const reference = { origin:'https://github.com/metalsharp/VKD3D-Proton-MacOS.git', commit:'4e89065e359f9c6c2a78170b045835d6382113d9', coreSha256:'56204f41b585eed6285ca559c58b62023d2b422a6f34686d7f80c316681e7af2' };
export function instrumentNgxCore(text) {
 if(text.includes('MacLauncherOriginalEvaluate'))throw Error('The NGX observer is already present.');
 const signature=/NVNGX_EXPORT NVNGX_RESULT NVSDK_NGX_D3D12_EvaluateFeature\(ID3D12GraphicsCommandList \*list, const unsigned int \*handle,\s*NVNGXParameter \*params, void \*callback\) \{/;
 if(!signature.test(text)||!text.includes('struct CommonFeature {'))throw Error('The declared NGX source interface differs.');
 // The original parameter store, original feature handles and original
 // capabilities remain authoritative; this observer creates no scaler.
 text=text.replace('namespace ngx {','#include "maclauncher-ngx/dll-observer.hpp"\n\nnamespace ngx {');
 text=text.replace('  NVNGX_FEATURE feature;','  NVNGX_FEATURE feature;\n  maclauncher::ngx::DllObserver sceneObserver;');
 text=text.replace(signature,`NVNGX_EXPORT NVNGX_RESULT NVSDK_NGX_D3D12_EvaluateFeature(ID3D12GraphicsCommandList*,const unsigned int*,NVNGXParameter*,void*);
static NVNGX_RESULT MacLauncherOriginalEvaluate(ID3D12GraphicsCommandList *list,const unsigned int *handle,NVNGXParameter *params,void *callback) {`);
 text+=`\nNVNGX_EXPORT NVNGX_RESULT NVSDK_NGX_D3D12_EvaluateFeature(ID3D12GraphicsCommandList *list,const unsigned int *handle,NVNGXParameter *params,void *callback) {
  return maclauncher::ngx::evaluateWithObservation([&]{return MacLauncherOriginalEvaluate(list,handle,params,callback);},[&]{
    maclauncher::ngx::ObservationResult observed;
    if(!handle||!params)return observed;
    auto feature=static_cast<CommonFeature*>((void*)handle);
    maclauncher::ngx::Feature kind;
    if(feature->feature==NVNGX_FEATURE_SUPERSAMPLING)kind=maclauncher::ngx::Feature::SuperResolution;
    else if(feature->feature==NVNGX_FEATURE_RAYRECONSTRUCTION)kind=maclauncher::ngx::Feature::RayReconstruction;
    else if(feature->feature==NVNGX_FEATURE_FRAMEGENERATION)kind=maclauncher::ngx::Feature::FrameGeneration;
    else return observed;
    observed.status=feature->sceneObserver.afterOriginal(list,*static_cast<ParametersImpl*>(params),kind,observed.nativeResult);
    return observed;
  },NVNGX_RESULT_OK,NVNGX_RESULT_FAIL);
}\n`;

 return text;
}
// Only the recipe's owned prepared source is adapted. Exact original notices,
// including Mullion's LGPL provenance in ngx.hpp/parameters.hpp, stay intact.
export function applyPreparedNgxOverlay(directory, expectedSourceSha256) {
 const file=path.join(directory,'ngx/nvngx/nvngx.cpp'),bytes=fs.readFileSync(file);
 if(expectedSourceSha256!==reference.coreSha256||crypto.createHash('sha256').update(bytes).digest('hex')!==expectedSourceSha256)throw Error('The NGX source differs from its declared exact input.');
 const here=import.meta.dirname;
 const copy=(source,target)=>{if(fs.existsSync(target))throw Error('The prepared NGX source already contains '+path.basename(target));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);};
 for(const name of ['dll-observer.hpp','command-bridge.hpp','scene-source.hpp','producer.hpp','parameters.hpp','routing.hpp'])copy(path.join(here,name),path.join(directory,'ngx/nvngx/maclauncher-ngx',name));
 for(const name of ['scene-request.h','scene-metadata.h','scene-metadata-native.h'])copy(path.resolve(here,'../vulkan',name),path.join(directory,'ngx/nvngx/vulkan',name));
 for(const name of ['reshade/temporal/frame.h','reshade/temporal/scene-aovs.h','reshade/temporal/scene-matrices.h','reshade/native/image-color.h'])copy(path.resolve(here,'../../../shared',name),path.join(directory,'shared',name));
 fs.writeFileSync(file,instrumentNgxCore(bytes.toString()));
 return {file:'ngx/nvngx/nvngx.cpp',reference};
}
