// Copyright (c) MacLauncher contributors. MIT license.
// Exact owned boundary: portable shader loading and resource-only preparation.
export function adaptRuntime(original) {
  let value = original;
  const changes = [];
  const replace = (before, after) => {
    if (value.split(before).length !== 2)
      throw Error('FSR4 runtime adaptation changed: ' + before.slice(0, 96));
    value = value.replace(before, after);
    changes.push({before, after});
  };
  replace(
      '            auto lib=[device_ newLibraryWithURL:url error:&e];',
      `            NSString *source=[NSString stringWithContentsOfURL:url encoding:NSUTF8StringEncoding error:&e];
            MTLCompileOptions *co=[MTLCompileOptions new];co.languageVersion=MTLLanguageVersion2_3;
            const bool relaxed=[entry[@"metal_math_mode"] isEqual:@"relaxed-fastfn"];
            const bool ordered=[entry[@"metal_math_mode"] isEqual:@"ordered-no-contract"];
            if(@available(macOS 15.0,*)) {
                co.mathMode=relaxed?MTLMathModeRelaxed:ordered?MTLMathModeSafe:MTLMathModeFast;
                co.mathFloatingPointFunctions=ordered?MTLMathFloatingPointFunctionsPrecise:MTLMathFloatingPointFunctionsFast;
            } else {error="FSR4 shader arithmetic requires macOS 15 or newer";return nullptr;}
            auto lib=source?[device_ newLibraryWithSource:source options:co error:&e]:nil;`);
  replace(
      '    id<MTLResidencySet> residency = nil;',
      '    id residency = nil; // Metal4 resource, used only after availability checks.');
  replace(
      '    bool busy = false;\n    bool retired() const {\n        return !busy || (constants && __atomic_load_n(',
      '    bool busy = false;\n    id<MTLCommandBuffer> completion = nil;\n    bool retired() const {\n        return !busy || (completion && completion.status==MTLCommandBufferStatusError) || (constants && __atomic_load_n(');
  replace(
      '        bool m4=![enc respondsToSelector:@selector(setBuffer:offset:atIndex:)];',
      '        bool m4=![enc respondsToSelector:@selector(setBuffer:offset:atIndex:)];\n        slot->completion=m4?nil:(id<MTLCommandBuffer>)cb;');
  replace(
      '        const bool m4 = ![enc respondsToSelector:@selector(setBuffer:offset:atIndex:)];',
      '        const bool m4 = ![enc respondsToSelector:@selector(setBuffer:offset:atIndex:)];\n        slot->completion=m4?nil:(id<MTLCommandBuffer>)commandBuffer;');
  for (
      const [before, after] of [
          [
            '        if (m4) [enc barrierAfterEncoderStages:MTLStageDispatch|MTLStageBlit beforeEncoderStages:MTLStageDispatch|MTLStageBlit visibilityOptions:MTL4VisibilityOptionDevice];',
            '        if(m4) {if(@available(macOS 26.0,*)) [enc barrierAfterEncoderStages:MTLStageDispatch|MTLStageBlit beforeEncoderStages:MTLStageDispatch|MTLStageBlit visibilityOptions:MTL4VisibilityOptionDevice];}'
          ],
          [
            '        [enc barrierAfterQueueStages:MTLStageAll beforeStages:MTLStageDispatch|MTLStageBlit visibilityOptions:MTL4VisibilityOptionDevice];',
            '        if(@available(macOS 26.0,*)) [enc barrierAfterQueueStages:MTLStageAll beforeStages:MTLStageDispatch|MTLStageBlit visibilityOptions:MTL4VisibilityOptionDevice];'
          ],
          [
            '        [enc barrierAfterStages:MTLStageDispatch|MTLStageBlit beforeQueueStages:MTLStageAll visibilityOptions:MTL4VisibilityOptionDevice];',
            '        if(@available(macOS 26.0,*)) [enc barrierAfterStages:MTLStageDispatch|MTLStageBlit beforeQueueStages:MTLStageAll visibilityOptions:MTL4VisibilityOptionDevice];'
          ]])
    replace(before, after);
  replace(
      'struct View {',
      'struct View {\n    Session *resourceSession=nullptr;\n    Kernels resourceKind=Kernels::Scalar;');
  const start = value.indexOf(
      '        if (!validate_textures(frame, error)) return fail(error);',
      value.indexOf('    bool encode(id commandBuffer'));
  const end = value.indexOf(
      '        const bool native_or_portable = kind != Kernels::Reference;',
      start);
  if (start < 0 || end < 0)
    throw Error('FSR4 preparation boundary changed.');
  const setup = value.slice(start, end);
  const prepare =
      setup.replaceAll('return fail(', 'return preparation_failure(');
  const body =
      `    // Creates resources without encoding commands, consuming frame IDs or
    // advancing input/model history. Called only on the provider preparation lane.
    bool prepare_resources(View &view,const Frame &frame,const Options &options,bool metal4,std::string &error) {
        auto preparation_failure=[&](const std::string&why){error=why;return false;};
${prepare}
        if(!ensure_targets(view,*session,p,frame,options,error))return false;
        // Preallocate the upstream bounded slot pool so encoding never creates
        // buffers/argument tables on the render thread.
        while(view.slots.size()<32) {
            auto slot=std::make_unique<FrameSlot>();
            slot->constants=[device_ newBufferWithLength:FrameSlot::kSize options:MTLResourceStorageModeShared];
            slot->tables=[NSMutableDictionary new];slot->resources=[NSMutableArray new];
            if(!slot->constants){error="Cannot allocate FSR4 frame constants";return false;}
            memset(slot->constants.contents,0,FrameSlot::kSize);view.slots.push_back(std::move(slot));
        }
        if(metal4)for(auto &slot:view.slots) {
            if(!prepare_tables(*slot,*session,view,error))return false;
            if(@available(macOS 26.0,*)) {if(!slot->residency){NSError*e=nil;slot->residency=[device_ newResidencySetWithDescriptor:[MTLResidencySetDescriptor new] error:&e];if(!slot->residency){error=metal_error(e);return false;}}}
        }
        view.resourceSession=session;view.resourceKind=kind;return true;
    }

`;
  value = value.slice(0, start) +
          `        if(!validate_textures(frame,error))return fail(error);
        Fsr4InputPrepared p={};auto status=fsr4_input_prepare(&frame.input,&view.inputHistory,0,&p);
        if(!fsr4_input_status_ok(status))return fail(fsr4_input_status_reason(status));
        const Kernels kind=view.resourceKind;const bool native=kind==Kernels::Mpp;
        Session *session=view.resourceSession;
        if(!session){error="FSR4 resources are preparing";return false;}
        const int tier=session->tier;
` + value.slice(end);
  const insertion = value.indexOf('    bool encode(id commandBuffer');
  value = value.slice(0, insertion) + body + value.slice(insertion);
  replace('        if (!slot) return fail(error);',
          '        if (!slot) return false;');
  replace(
      '        if (!ensure_targets(view, *session, p, frame, options, error)) return fail(error);',
      '        // Exact provider input contract was prepared before this encode.');
  replace(
      '        if (p.copyMask & FSR4_INPUT_COPY_OUTPUT) ok &= fit(v.outputCopy,MTLPixelFormatRGBA32Float,p.uw,p.uh);',
      '        ok &= fit(v.outputCopy,MTLPixelFormatRGBA32Float,p.uw,p.uh);');
  replace(
      '            if (p.copyMask & FSR4_INPUT_COPY_OUTPUT) b.output = view.outputCopy;',
      '            b.output = view.outputCopy;');
  replace(
      '            if (p.copyMask & FSR4_INPUT_COPY_OUTPUT) {\n                const Fsr4InputRect region{0,0,p.uw,p.uh};\n                copy(enc,m4,*slot,"copyOutput",view.outputCopy,frame.output,region,p.outputRegion.x,p.outputRegion.y,9984,false);\n            }',
      `            RegionConstants compose={{p.colorRegion.x,p.colorRegion.y,p.rw,p.rh},{p.outputRegion.x,p.outputRegion.y,p.uw,p.uh}};
            put(*slot,9984,compose);
            helper(enc,m4,*slot,"copyOutput","fsr411_compose",{{slot->constants,9984}},
                {view.outputCopy,frame.color,frame.output},MTLSizeMake(p.uw,p.uh,1));`);
  replace(
      '"fsr411_snapshot","fsr411_exposure","fsr411_init_exposure","fsr411_retire"',
      '"fsr411_snapshot","fsr411_exposure","fsr411_init_exposure","fsr411_retire","fsr411_compose"');
  return {
    source : value,
    adaptations : changes,
    preparationBoundary : {sha256Input : original.length, sourceSetup : setup}
  };
}
export function adaptHelpers(original) {
  if (original.includes('fsr411_compose'))
    throw Error('FSR4 helper adaptation already applied.');
  return original + `
// Preserve the caller's actual alpha without changing the original model RGB.
// Source alpha is bilinearly resized within the exact source ROI on the GPU.
kernel void fsr411_compose(texture2d<float,access::read> model [[texture(0)]],
 texture2d<float,access::read> color [[texture(1)]],texture2d<float,access::write> output [[texture(2)]],
 constant Region&r [[buffer(0)]],uint2 p [[thread_position_in_grid]]) {
 if(any(p>=r.destination.zw))return;
 float2 at=(float2(p)+.5)*float2(r.source.zw)/float2(r.destination.zw)-.5;
 int2 base=int2(floor(at));float2 mix=fract(at);int2 limit=int2(r.source.zw)-1;
 uint2 p00=uint2(clamp(base,int2(0),limit))+r.source.xy;
 uint2 p10=uint2(clamp(base+int2(1,0),int2(0),limit))+r.source.xy;
 uint2 p01=uint2(clamp(base+int2(0,1),int2(0),limit))+r.source.xy;
 uint2 p11=uint2(clamp(base+int2(1,1),int2(0),limit))+r.source.xy;
 float alpha=mix(mix(color.read(p00).a,color.read(p10).a,mix.x),mix(color.read(p01).a,color.read(p11).a,mix.x),mix.y);
 output.write(float4(model.read(p).rgb,alpha),p+r.destination.xy);
}
`.replaceAll('float2 mix=', 'float2 fraction=')
                        .replaceAll('mix.x', 'fraction.x')
                        .replaceAll('mix.y', 'fraction.y');
}
