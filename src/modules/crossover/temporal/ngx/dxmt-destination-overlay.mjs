// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
function once(text,before,after){if(text.split(before).length!==2)throw Error('The DXMT swapchain source interface differs.');return text.replace(before,after);}
export function instrumentDxmtDestination(text,api){
 if(text.includes('maclauncher_ngx_destination.hpp'))throw Error('The DXMT destination adapter is already present.');
 text=once(text,'#include "dxgi_interfaces.h"','#include "dxgi_interfaces.h"\n#include "maclauncher_ngx_destination.hpp"');
 text=once(text,'  dxmt::mutex mutex_;','  dxmt::mutex mutex_;\n  maclauncher::ngx::SwapchainDestination ngx_destination_;');
 text=once(text,`  ~MTLD3D${api}SwapChain() {`,`  ~MTLD3D${api}SwapChain() {\n    ngx_destination_.retire();`);
 if(api===11){
  text=once(text,'      return backbuffer_->QueryInterface(riid, surface);',`      const auto result=backbuffer_->QueryInterface(riid, surface);
      if(SUCCEEDED(result)&&surface&&*surface)ngx_destination_.attach(this,static_cast<IUnknown*>(*surface));
      return result;`);
  text=once(text,'                UINT flags) final {','                UINT flags) final {\n    ngx_destination_.retire();');
 }else if(api===12){
  text=once(text,'    return backbuffers_[Buffer]->QueryInterface(riid, ppSurface);',`    const auto result=backbuffers_[Buffer]->QueryInterface(riid, ppSurface);
    if(SUCCEEDED(result)&&ppSurface&&*ppSurface)ngx_destination_.attach(this,static_cast<IUnknown*>(*ppSurface));
    return result;`);
  text=once(text,'  ResizeBuffers(UINT BufferCount, UINT Width, UINT Height, DXGI_FORMAT Format, UINT flags) final {',
   '  ResizeBuffers(UINT BufferCount, UINT Width, UINT Height, DXGI_FORMAT Format, UINT flags) final {\n    ngx_destination_.retire();');
 }else throw Error('A typed DXMT Direct3D swapchain is required.');
 return text;
}
// The existing renderer recipe copies upstream before calling this function.
// No window, resource or presentation operation runs while adapting source.
export function applyDxmtDestinationOverlay(directory){
 const writes=new Map();
 for(const api of [11,12]){const file=path.join(directory,`src/d3d${api}/d3d${api}_swapchain.cpp`);writes.set(file,instrumentDxmtDestination(fs.readFileSync(file,'utf8'),api));}
 const header=path.join(directory,'include/maclauncher_ngx_destination.hpp');
 if(fs.existsSync(header))throw Error('The prepared source already contains a destination adapter.');
 for(const [file,text]of writes)fs.writeFileSync(file,text);
 fs.copyFileSync(new URL('./destination.hpp',import.meta.url),header);
}
