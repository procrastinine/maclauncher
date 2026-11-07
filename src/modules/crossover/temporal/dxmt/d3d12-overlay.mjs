// Copyright (c) MacLauncher contributors. MIT license.
import fs from'node:fs';import path from'node:path';
export function applyTemporalD3D12(root){
 const replace=(file,before,after)=>{const p=path.join(root,file),s=fs.readFileSync(p,'utf8');if(s.split(before).length!==2)throw Error('DXMT D3D12 source anchor differs: '+file);fs.writeFileSync(p,s.replace(before,after));};
 const files=['temporal-d3d12.h','temporal-d3d12-pass.hpp','temporal-d3d12-record.inc','temporal-d3d12-exports.inc','temporal-d3d12-encode.inc','ngx-d3d12.inc'];
 for(const file of files)fs.copyFileSync(new URL(file,import.meta.url),path.join(root,'include',file));
 replace('src/winemetal/winemetal.h','  enum WMTPixelFormat reactive_format;','  enum WMTPixelFormat reactive_format;\n  bool output_resolution_motion;\n  bool jittered_motion;');
 replace('src/d3d12/d3d12_command_encoder.hpp','  Resolve,','  Resolve,\n  TemporalUpscale,');
 for(const file of ['d3d12_command_list.cpp','d3d12_command_allocator.cpp','d3d12_command_queue.cpp']){
  const p=path.join(root,'src/d3d12',file);fs.appendFileSync(p,'\n');
  replace('src/d3d12/'+file,'namespace dxmt {','#include "temporal-d3d12-pass.hpp"\nnamespace dxmt {');
 }
 replace('src/d3d12/d3d12_command_list.cpp','  HRESULT\n  STDMETHODCALLTYPE\n  QueryInterface(REFIID riid, void **ppvObject) {','  #include "temporal-d3d12-record.inc"\n\n  HRESULT\n  STDMETHODCALLTYPE\n  QueryInterface(REFIID riid, void **ppvObject) {');
 replace('src/d3d12/d3d12_command_list.cpp','}; // namespace dxmt','#include "temporal-d3d12-exports.inc"\n}; // namespace dxmt');
 replace('src/d3d12/d3d12_command_allocator.cpp','      case EncoderType::Resolve:', '      case EncoderType::TemporalUpscale:\n        reinterpret_cast<MLTemporal12Pass*>(next)->~MLTemporal12Pass();break;\n      case EncoderType::Resolve:');
 replace('src/d3d12/d3d12_command_queue.cpp','        case EncoderType::Resolve:', '        #include "temporal-d3d12-encode.inc"\n        case EncoderType::Resolve:');
 replace('src/nvngx/nvngx.cpp','namespace dxmt {','#include \"temporal-d3d12.h\"\n#include <mutex>\n#include <memory>\nnamespace dxmt {');
 replace('src/nvngx/nvngx.cpp','}; // namespace dxmt','#include "ngx-d3d12.inc"\n}; // namespace dxmt');
}
