// Temporal creation and dispatch are adapted; all other Wine/Metal entrypoints
// retain the selected runtime's implementation and shader compiler.
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <MetalFX/MetalFX.h>
#define WINEMETAL_API
#include "winemetal_thunks.h"
#include "scene-aovs.h"

typedef int (*MLUnixCall)(void *);
typedef int (*MLCameraSetter)(void *, void *, const RSTemporalCamera *);
MLUnixCall __wine_unix_call_funcs[ML_UNIX_CALL_COUNT];
MLUnixCall __wine_unix_call_wow64_funcs[ML_UNIX_CALL_COUNT];
static MLUnixCall originalTemporal,originalCreate;
static MLCameraSetter setCamera;
typedef int (*MLSceneSetter)(void*,void*,void*,void*,const RSSceneAovs*,const RSSceneAovRetirement*);
typedef void (*MLSceneClear)(void*);
typedef uint32_t (*MLSceneDemand)(uint32_t);
static MLSceneSetter setScene;
static MLSceneClear clearScene;
static MLSceneDemand sceneDemand;
static pthread_once_t resolveCamera = PTHREAD_ONCE_INIT;

static void resolve_camera(void) {
  setCamera = (MLCameraSetter)dlsym(RTLD_DEFAULT, "rsSetTemporalCamera");
  uint32_t (*api)(void)=(void*)dlsym(RTLD_DEFAULT,"rsSceneAovAPI");
  if(api&&api()==RS_SCENE_AOV_ABI_VERSION){setScene=(void*)dlsym(RTLD_DEFAULT,"rsSetTemporalAovsForTexturesObserved");clearScene=(void*)dlsym(RTLD_DEFAULT,"rsClearTemporalAovsTextures");sceneDemand=(void*)dlsym(RTLD_DEFAULT,"rsGetSceneAovDemand");}
}

@interface MLStreamlineCopies:NSObject {
@public id<MTLTexture> hudlessStorage,uiStorage,hudless,ui;
}
@end
@implementation MLStreamlineCopies
-(void)dealloc{[hudless release];[ui release];[hudlessStorage release];[uiStorage release];[super dealloc];}
@end
static void retire_scene(void *context,uint64_t frame,uint64_t view,uint64_t epoch){(void)frame;(void)view;(void)epoch;[(MLStreamlineCopies*)context release];}
static id<MTLTexture> snapshot_image(id<MTLCommandBuffer>commands,const MLStreamlineNativeImage *source,id<MTLTexture>*storage){
  id<MTLTexture> input=(id<MTLTexture>)source->texture;
  if(!input||input.device!=commands.device||input.textureType!=MTLTextureType2D||input.sampleCount!=1||!source->width||!source->height||
      (uint64_t)source->x+source->width>input.width||(uint64_t)source->y+source->height>input.height)return nil;
  MTLPixelFormat encoded=input.pixelFormat,raw;
  if(encoded==MTLPixelFormatRGBA8Unorm_sRGB)raw=MTLPixelFormatRGBA8Unorm;
  else if(encoded==MTLPixelFormatBGRA8Unorm_sRGB)raw=MTLPixelFormatBGRA8Unorm;
  else return nil;
  MTLTextureDescriptor *desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:encoded width:source->width height:source->height mipmapped:NO];
  desc.storageMode=MTLStorageModePrivate;desc.usage=MTLTextureUsageShaderRead|MTLTextureUsagePixelFormatView;
  *storage=[commands.device newTextureWithDescriptor:desc];if(!*storage)return nil;
  id<MTLTexture> view=[*storage newTextureViewWithPixelFormat:raw];if(!view)return nil;
  id<MTLBlitCommandEncoder>blit=[commands blitCommandEncoder];if(!blit){[view release];return nil;}
  [blit copyFromTexture:input sourceSlice:0 sourceLevel:0 sourceOrigin:(MTLOrigin){source->x,source->y,0} sourceSize:(MTLSize){source->width,source->height,1} toTexture:*storage destinationSlice:0 destinationLevel:0 destinationOrigin:(MTLOrigin){0,0,0}];[blit endEncoding];
  return view;
}
static void publish_scene(struct unixcall_mtlcommandbuffer_temporal_scale *params,const struct WMTFXTemporalScalerProps *props){
  if(clearScene)clearScene((void*)params->scaler);
  const MLStreamlineNativeResources *source=&props->streamline;
  const uint32_t pair=(1u<<RS_SCENE_AOV_HUDLESS_COLOR)|(1u<<RS_SCENE_AOV_UI_COLOR_ALPHA);
  if(!setScene||!clearScene||!sceneDemand||(sceneDemand(1)&pair)!=pair||source->size!=sizeof(*source)||source->version!=1||!source->frameId||!source->epoch||
      source->frameId!=props->camera.frameId||source->viewId!=props->camera.viewportId||!source->hudless.texture||!source->ui.texture)return;
  id<MTLCommandBuffer>commands=(id<MTLCommandBuffer>)params->cmdbuf;
  if(!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted)return;
  @autoreleasepool{
    MLStreamlineCopies *copies=[MLStreamlineCopies new];
    copies->hudless=snapshot_image(commands,&source->hudless,&copies->hudlessStorage);
    copies->ui=snapshot_image(commands,&source->ui,&copies->uiStorage);
    // The command handler retains copies even for an abandoned/unsubmitted
    // command until that command is destroyed. Core retirement is independent.
    [commands addCompletedHandler:^(id<MTLCommandBuffer>finished){(void)finished;[copies self];}];
    if(copies->hudless&&copies->ui){
      RSSceneAovs packet={0};packet.size=sizeof(packet);packet.version=1;packet.frameId=source->frameId;packet.viewId=source->viewId+1;packet.epoch=source->epoch;packet.imageRevision=source->imageRevision;
      // No scene-radiance AOV is published. Its linear color descriptor is
      // unused; encoded HUD and UI each retain their actual independent tags.
      packet.color=(struct RSImageColorDescription){sizeof(packet.color),1,RS_COLOR_BT709,RS_COLOR_LINEAR,RS_COLOR_FULL,RS_COLOR_OPAQUE,203,203,0,1.2f,0,0};
      packet.preExposure=1;packet.pass=packet.colorPass=RS_SCENE_AOV_AFTER_TRANSPARENT;packet.hudlessColor=source->hudlessColor;packet.uiColor=source->uiColor;
      packet.images[RS_SCENE_AOV_HUDLESS_COLOR]=(RSSceneAovImage){(void*)copies->hudless,0,0,(uint32_t)copies->hudless.width,(uint32_t)copies->hudless.height,RS_SCENE_AOV_COLOR,RS_SCENE_AOV_SPACE_NONE,0,RS_SCENE_AOV_TOP_LEFT,1,0,RS_SCENE_AOV_AFTER_TRANSPARENT,0};
      packet.images[RS_SCENE_AOV_UI_COLOR_ALPHA]=(RSSceneAovImage){(void*)copies->ui,0,0,(uint32_t)copies->ui.width,(uint32_t)copies->ui.height,RS_SCENE_AOV_COLOR,RS_SCENE_AOV_SPACE_NONE,0,RS_SCENE_AOV_TOP_LEFT,1,0,RS_SCENE_AOV_AFTER_TRANSPARENT,0};
      RSSceneAovRetirement observer={sizeof(observer),1,[copies retain],retire_scene};
      if(setScene((void*)params->scaler,(void*)params->color,(void*)params->depth,(void*)params->motion,&packet,&observer)!=RS_TEMPORAL_OK)[copies release];
    }
    [copies release];
  }
}
static int create_temporal(void *data) {
  struct unixcall_mtldevice_newfxtemporalscaler *params=data;
  const struct WMTFXTemporalScalerInfo *info=params->info.ptr;
  if(!info->reactive_format)return originalCreate(data);
  params->ret=0;
  if(@available(macOS 14.4,*)){
    MTLFXTemporalScalerDescriptor *descriptor=[MTLFXTemporalScalerDescriptor new];
    descriptor.colorTextureFormat=(MTLPixelFormat)(info->color_format&~WMTPixelFormatCustomSwizzle);
    descriptor.outputTextureFormat=(MTLPixelFormat)(info->output_format&~WMTPixelFormatCustomSwizzle);
    descriptor.depthTextureFormat=(MTLPixelFormat)(info->depth_format&~WMTPixelFormatCustomSwizzle);
    descriptor.motionTextureFormat=(MTLPixelFormat)(info->motion_format&~WMTPixelFormatCustomSwizzle);
    descriptor.inputWidth=info->input_width;descriptor.inputHeight=info->input_height;
    descriptor.outputWidth=info->output_width;descriptor.outputHeight=info->output_height;
    descriptor.inputContentMinScale=info->input_content_min_scale;descriptor.inputContentMaxScale=info->input_content_max_scale;
    descriptor.inputContentPropertiesEnabled=info->input_content_properties_enabled;descriptor.autoExposureEnabled=info->auto_exposure;
    descriptor.reactiveMaskTextureEnabled=YES;descriptor.reactiveMaskTextureFormat=(MTLPixelFormat)(info->reactive_format&~WMTPixelFormatCustomSwizzle);
    if(@available(macOS 15.0,*))descriptor.requiresSynchronousInitialization=info->requires_synchronous_initialization;
    params->ret=(obj_handle_t)[descriptor newTemporalScalerWithDevice:(id<MTLDevice>)params->device];
    [descriptor release];
  }
  return 0;
}
static int temporal(void *data) {
  struct unixcall_mtlcommandbuffer_temporal_scale *params = data;
  const struct WMTFXTemporalScalerProps *props = params->props.ptr;
  if(@available(macOS 14.4,*))((id<MTLFXTemporalScaler>)params->scaler).reactiveMaskTexture=(id<MTLTexture>)props->reactive_texture;
  pthread_once(&resolveCamera, resolve_camera);
  publish_scene(params,props);
  if (setCamera) setCamera((void *)params->scaler, (void *)params->cmdbuf,
      props->camera.size == sizeof(RSTemporalCamera) ? &props->camera : NULL);
  return originalTemporal(data);
}
static int unavailable(void *data) { (void)data; return (int)0xc0000135; }

__attribute__((constructor)) static void initialize_forwarder(void) {
  for (unsigned i = 0; i < ML_UNIX_CALL_COUNT; ++i)
    __wine_unix_call_funcs[i] = __wine_unix_call_wow64_funcs[i] = unavailable;
  const char *path = getenv("MACLAUNCHER_DXMT_BASE_LIBRARY");
  void *base = path && path[0] == '/' ? dlopen(path, RTLD_NOW | RTLD_LOCAL) : NULL;
  MLUnixCall *native = base ? dlsym(base, "__wine_unix_call_funcs") : NULL;
  MLUnixCall *wow64 = base ? dlsym(base, "__wine_unix_call_wow64_funcs") : NULL;
  if (!native || !wow64 || native == __wine_unix_call_funcs || !native[56] || !native[58]) {
    fprintf(stderr, "DXMT camera bridge requires its matching original Metal library.\n");
    return;
  }
  memcpy(__wine_unix_call_funcs, native, sizeof(__wine_unix_call_funcs));
  memcpy(__wine_unix_call_wow64_funcs, wow64, sizeof(__wine_unix_call_wow64_funcs));
  originalTemporal = native[58];
  originalCreate=native[56];
  __wine_unix_call_funcs[56]=create_temporal;
  __wine_unix_call_funcs[58] = temporal;
  // 32-bit clients retain their existing descriptor layout and are forwarded.
}
