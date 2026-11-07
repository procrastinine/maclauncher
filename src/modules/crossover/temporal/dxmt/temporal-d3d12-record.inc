// Copyright (c) MacLauncher contributors. MIT license.
// Included in the actual producer's public command-list implementation.
HRESULT mlRecordTemporal12(const MLTemporalD3D12&input,void**history){
 if(!history||input.size!=sizeof(input)||input.version!=1||!allocator_||
    encoder_count!=std::numeric_limits<size_t>::max()||!input.color||!input.depth||!input.motion||!input.output||
    !input.width||!input.height||!input.maxWidth||!input.maxHeight||input.width>input.maxWidth||input.height>input.maxHeight)
  return E_INVALIDARG;
 if(!device_->GetMTLDevice().supportsFXTemporalScaler())return DXGI_ERROR_UNSUPPORTED;
 if(input.output==input.color||input.output==input.depth||input.output==input.motion)return E_INVALIDARG;
 ID3D12Resource*resources[]={input.color,input.depth,input.motion,input.output,input.exposure};
 TextureViewRef views[5];
 for(unsigned i=0;i<5;i++){
  if(!resources[i])continue;
  Com<ID3D12Device>owner;
  const HRESULT deviceResult=resources[i]->GetDevice(IID_PPV_ARGS(&owner));
  if(FAILED(deviceResult))return deviceResult;
  if(owner.ptr()!=static_cast<ID3D12Device*>(device_))return E_INVALIDARG;
  auto desc=resources[i]->GetDesc();
  if(desc.Dimension!=D3D12_RESOURCE_DIMENSION_TEXTURE2D||desc.DepthOrArraySize!=1||desc.SampleDesc.Count!=1||desc.MipLevels!=1)return E_INVALIDARG;
  // These are this device's producer objects, just as CopyTextureRegion uses.
  auto texture=static_cast<MTLD3D12Resource*>(resources[i])->texture;
  if(!texture)return E_INVALIDARG;
  views[i]=texture->view(texture->fullView);
  if(!views[i])return E_INVALIDARG;
 }
 const auto color=input.color->GetDesc(),depth=input.depth->GetDesc(),motion=input.motion->GetDesc(),output=input.output->GetDesc();
 if(input.width>color.Width||input.height>color.Height||input.width>depth.Width||input.height>depth.Height||(input.displayMotion?output.Width:input.width)>motion.Width||(input.displayMotion?output.Height:input.height)>motion.Height)return E_INVALIDARG;
 WMTFXTemporalScalerInfo info{};
 info.color_format=views[0].texture().pixelFormat();info.depth_format=views[1].texture().pixelFormat();
 info.motion_format=views[2].texture().pixelFormat();info.output_format=views[3].texture().pixelFormat();
 info.input_width=input.maxWidth;info.input_height=input.maxHeight;info.output_width=output.Width;info.output_height=output.Height;
 info.input_content_min_scale=1;info.input_content_max_scale=3;info.input_content_properties_enabled=true;
 info.output_resolution_motion=input.displayMotion;info.jittered_motion=bool(input.flags&RS_TEMPORAL_JITTERED_MOTION);
 info.auto_exposure=input.autoExposure;info.requires_synchronous_initialization=true;
 auto prior=static_cast<MLTemporal12History*>(*history);
 if(prior&&prior->device.ptr()!=static_cast<ID3D12Device*>(device_))return E_INVALIDARG;
 auto equal=[&]{return prior&&prior->info.color_format==info.color_format&&prior->info.depth_format==info.depth_format&&
  prior->info.motion_format==info.motion_format&&prior->info.output_format==info.output_format&&prior->info.input_width==info.input_width&&
  prior->info.input_height==info.input_height&&prior->info.output_width==info.output_width&&prior->info.output_height==info.output_height&&prior->info.auto_exposure==info.auto_exposure&&prior->info.output_resolution_motion==info.output_resolution_motion&&prior->info.jittered_motion==info.jittered_motion;};
 if(!equal()){
  auto next=std::make_unique<MLTemporal12History>();next->device=device_;next->info=info;
  next->scaler=new TemporalScaler(device_->GetMTLDevice(),info);
  if(!next->scaler->scaler())return DXGI_ERROR_UNSUPPORTED;
  delete prior;prior=next.release();*history=prior;
 }
 allocator_->InvalidateCurrentPass();
 auto pass=allocator_->AllocatePass<MLTemporal12Pass>();pass->type=EncoderType::TemporalUpscale;
 pass->scaler=prior->scaler;
 for(unsigned i=0;i<5;i++){pass->resources[i]=resources[i];pass->images[i]=views[i];}
 auto&props=pass->props;
 props.input_content_width=input.width;props.input_content_height=input.height;
 props.jitter_offset_x=input.jitterX;props.jitter_offset_y=input.jitterY;
 props.motion_vector_scale_x=input.motionScaleX;props.motion_vector_scale_y=input.motionScaleY;
 props.pre_exposure=input.preExposure;props.reset=input.reset;props.depth_reversed=bool(input.flags&RS_TEMPORAL_DEPTH_REVERSED);props.camera=input.camera;
 if(!props.camera.size){props.camera.size=sizeof(props.camera);props.camera.version=1;props.camera.flags=RS_TEMPORAL_FRAME_METADATA_ONLY;}
 props.camera.flags=props.camera.flags&RS_TEMPORAL_FRAME_METADATA_ONLY?RS_TEMPORAL_FRAME_METADATA_ONLY|(input.flags&~RS_TEMPORAL_AUTO_EXPOSURE):
  (props.camera.flags&(RS_TEMPORAL_DEPTH_REVERSED|RS_TEMPORAL_DEPTH_INFINITE))|(input.flags&~(RS_TEMPORAL_DEPTH_REVERSED|RS_TEMPORAL_AUTO_EXPOSURE));
 props.camera.frameId=input.frameId;props.camera.frameTimeMs=input.frameTimeMs;
 allocator_->InvalidateCurrentPass();
 return S_OK;
}
