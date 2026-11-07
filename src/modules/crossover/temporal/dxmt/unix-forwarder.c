// Temporal creation and dispatch are adapted; all other Wine/Metal entrypoints
// retain the selected runtime's implementation and shader compiler.
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <math.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <MetalFX/MetalFX.h>
#import <objc/runtime.h>
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
typedef int (*MLDestinationSetter)(void*,void*,void*,void*,void*,uint64_t);
static MLDestinationSetter setDestination;
static MLSceneClear clearDestination;
static MLSceneClear releaseOwner;
static int destinationEnabled;
static pthread_once_t resolveCamera = PTHREAD_ONCE_INIT;

static void resolve_camera(void) {
  setCamera = (MLCameraSetter)dlsym(RTLD_DEFAULT, "rsSetTemporalCamera");
  const char*enabled=getenv("MACLAUNCHER_NGX_SCENE_DESTINATION_ENABLE");destinationEnabled=enabled&&!strcmp(enabled,"1");
  if(destinationEnabled){
    setDestination=(MLDestinationSetter)dlsym(RTLD_DEFAULT,"rsSetTemporalSceneDestinationForTextures");
    clearDestination=(MLSceneClear)dlsym(RTLD_DEFAULT,"rsClearTemporalSceneDestinationTextures");
    releaseOwner=(MLSceneClear)dlsym(RTLD_DEFAULT,"rsReleaseTemporalOwner");
  }
  uint32_t (*api)(void)=(void*)dlsym(RTLD_DEFAULT,"rsSceneAovAPI");
  if(api&&api()==RS_SCENE_AOV_ABI_VERSION){setScene=(void*)dlsym(RTLD_DEFAULT,"rsSetTemporalAovsForTexturesObserved");clearScene=(void*)dlsym(RTLD_DEFAULT,"rsClearTemporalAovsTextures");sceneDemand=(void*)dlsym(RTLD_DEFAULT,"rsGetSceneAovDemand");}
}

@interface MLDestinationOwner:NSObject {@public void*key;}
@end
@implementation MLDestinationOwner
-(void)dealloc{if(clearDestination&&key)clearDestination(key);if(releaseOwner&&key)releaseOwner(key);[super dealloc];}
@end
static char destinationAssociation;
static int known_scene_color(const MLStreamlineNativeResourcesV2*value){
  const MLStreamlineNativeResources*base=&value->base;
  if(base->version!=2||base->size!=sizeof(*value))return 0;
  const struct RSImageColorDescription*c=&value->sceneColor;
  return value->sceneColorKnown==1&&!value->reserved&&value->scenePass<=RS_SCENE_AOV_TEMPORAL_INPUT&&value->sceneColorPass<=RS_SCENE_AOV_TEMPORAL_INPUT&&c->size==sizeof(*c)&&c->version==1&&
    c->primaries<=RS_COLOR_BT2020&&c->transfer==RS_COLOR_LINEAR&&c->range<=RS_COLOR_LIMITED&&c->alpha<=RS_COLOR_OPAQUE&&
    !c->reserved&&!(c->flags&~RS_COLOR_SCENE_REFERRED)&&isfinite(c->referenceWhite)&&c->referenceWhite>0&&
    isfinite(c->peakLuminance)&&c->peakLuminance>=c->referenceWhite&&isfinite(c->blackLuminance)&&
    c->blackLuminance>=0&&c->blackLuminance<c->peakLuminance&&isfinite(c->hlgSystemGamma)&&c->hlgSystemGamma>0;
}
struct MLDestinationCall {
  struct unixcall_mtlcommandbuffer_temporal_scale *recording;
  uint64_t frame;int result;
};
static void bind_destination(void*storage,void*actualWindow){
  struct MLDestinationCall*call=storage;
  const struct unixcall_mtlcommandbuffer_temporal_scale*p=call->recording;
  call->result=setDestination((void*)p->scaler,actualWindow,(void*)p->color,(void*)p->depth,(void*)p->motion,call->frame);
}
static void publish_destination(struct unixcall_mtlcommandbuffer_temporal_scale*recording,const struct WMTFXTemporalScalerProps*props){
  if(!destinationEnabled)return;
  typedef int(*WithWindow)(uint64_t,void(*)(void*,void*),void*);
  const MLStreamlineNativeResourcesV2*value=(const MLStreamlineNativeResourcesV2*)&props->streamline;
  const MLStreamlineNativeResources*base=&value->base;
  void*library;WithWindow withWindow;const char*path;
  struct MLDestinationCall call={recording,base->frameId,RS_TEMPORAL_UNAVAILABLE};
  if(clearDestination)clearDestination((void*)recording->scaler);
  // Old producers stop at the original prefix. Read no tail until the exact
  // new layout has been declared by this actual typed recording.
  if(!setDestination||!clearDestination||!releaseOwner||!known_scene_color(value)||
     !base->frameId||base->frameId!=props->camera.frameId||base->viewId!=props->camera.viewportId||
     !base->epoch||!value->destinationWindow||!isfinite(props->camera.frameTimeMs)||props->camera.frameTimeMs<=0||
     !recording->scaler||!recording->color||!recording->depth||!recording->motion)return;
  id<MTLCommandBuffer>commands=(id<MTLCommandBuffer>)recording->cmdbuf;
  if(!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted)return;
  path=getenv("MACLAUNCHER_NGX_WINEMAC_LIBRARY");if(!path||path[0]!='/')return;
  library=dlopen(path,RTLD_NOW|RTLD_LOCAL|RTLD_NOLOAD);if(!library)return;
  withWindow=(WithWindow)dlsym(library,"MacLauncherWineMacWithWindow1");
  if(withWindow&&withWindow(value->destinationWindow,bind_destination,&call)&&call.result==RS_TEMPORAL_OK){
    id scaler=(id)recording->scaler;
    if(!objc_getAssociatedObject(scaler,&destinationAssociation)){
      MLDestinationOwner*owner=[MLDestinationOwner new];owner->key=(void*)recording->scaler;
      objc_setAssociatedObject(scaler,&destinationAssociation,owner,OBJC_ASSOCIATION_RETAIN_NONATOMIC);[owner release];
    }
  }
  dlclose(library);
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
static int publish_scene(struct unixcall_mtlcommandbuffer_temporal_scale *params,const struct WMTFXTemporalScalerProps *props){
  if(!destinationEnabled)return 0;
  if(clearScene)clearScene((void*)params->scaler);
  const MLStreamlineNativeResources *source=(const MLStreamlineNativeResources*)&props->streamline;
  const MLStreamlineNativeResourcesV2 *extended=(const MLStreamlineNativeResourcesV2*)source;
  const uint32_t pair=(1u<<RS_SCENE_AOV_HUDLESS_COLOR)|(1u<<RS_SCENE_AOV_UI_COLOR_ALPHA);
  if(!setScene||!clearScene||!known_scene_color(extended)||!source->frameId||!source->epoch||
      source->frameId!=props->camera.frameId||source->viewId!=props->camera.viewportId||
      !isfinite(props->camera.frameTimeMs)||props->camera.frameTimeMs<=0)return 0;
  id<MTLCommandBuffer>commands=(id<MTLCommandBuffer>)params->cmdbuf;
  if(!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted)return 0;
  const float exposure=props->pre_exposure==0?1:props->pre_exposure;
  if(!isfinite(exposure)||exposure<=0)return 0;
  int bound=0;
  @autoreleasepool{
    MLStreamlineCopies *copies=[MLStreamlineCopies new];
    if(sceneDemand&&(sceneDemand(1)&pair)==pair&&source->hudless.texture&&source->ui.texture){
      copies->hudless=snapshot_image(commands,&source->hudless,&copies->hudlessStorage);
      copies->ui=snapshot_image(commands,&source->ui,&copies->uiStorage);
    }
    // The command handler retains copies even for an abandoned/unsubmitted
    // command until that command is destroyed. Core retirement is independent.
    [commands addCompletedHandler:^(id<MTLCommandBuffer>finished){(void)finished;[copies self];}];
      RSSceneAovs packet={0};packet.size=sizeof(packet);packet.version=1;packet.frameId=source->frameId;packet.viewId=source->viewId+1;packet.epoch=source->epoch;packet.imageRevision=source->imageRevision;
      packet.color=extended->sceneColor;packet.preExposure=exposure;
      packet.pass=extended->scenePass;packet.colorPass=extended->sceneColorPass;
      packet.hudlessColor=source->hudlessColor;packet.uiColor=source->uiColor;
    if(copies->hudless&&copies->ui){
      packet.images[RS_SCENE_AOV_HUDLESS_COLOR]=(RSSceneAovImage){(void*)copies->hudless,0,0,(uint32_t)copies->hudless.width,(uint32_t)copies->hudless.height,RS_SCENE_AOV_COLOR,RS_SCENE_AOV_SPACE_NONE,0,RS_SCENE_AOV_TOP_LEFT,1,0,RS_SCENE_AOV_AFTER_TRANSPARENT,0};
      packet.images[RS_SCENE_AOV_UI_COLOR_ALPHA]=(RSSceneAovImage){(void*)copies->ui,0,0,(uint32_t)copies->ui.width,(uint32_t)copies->ui.height,RS_SCENE_AOV_COLOR,RS_SCENE_AOV_SPACE_NONE,0,RS_SCENE_AOV_TOP_LEFT,1,0,RS_SCENE_AOV_AFTER_TRANSPARENT,0};
    }
    RSSceneAovRetirement observer={sizeof(observer),1,[copies retain],retire_scene};
    bound=setScene((void*)params->scaler,(void*)params->color,(void*)params->depth,(void*)params->motion,&packet,&observer)==RS_TEMPORAL_OK;
    if(!bound)[copies release];
    [copies release];
  }
  return bound;
}
static int create_temporal(void *data) {
  struct unixcall_mtldevice_newfxtemporalscaler *params=data;
  const struct WMTFXTemporalScalerInfo *info=params->info.ptr;
  if(!info->reactive_format&&!info->output_resolution_motion&&!info->jittered_motion)return originalCreate(data);
  params->ret=0;
  if(info->output_resolution_motion||info->jittered_motion){
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 270000
    if(@available(macOS 27.0,*)){}else return 0;
#else
    return 0;
#endif
  }
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
    descriptor.reactiveMaskTextureEnabled=info->reactive_format!=0;descriptor.reactiveMaskTextureFormat=(MTLPixelFormat)(info->reactive_format&~WMTPixelFormatCustomSwizzle);
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 270000
    if(@available(macOS 27.0,*)){descriptor.outputResolutionMotionVectorsEnabled=info->output_resolution_motion;descriptor.jitteredMotionVectorsEnabled=info->jittered_motion;}
#endif
    if(@available(macOS 15.0,*))descriptor.requiresSynchronousInitialization=info->requires_synchronous_initialization;
    params->ret=(obj_handle_t)[descriptor newTemporalScalerWithDevice:(id<MTLDevice>)params->device];
    [descriptor release];
  }
  return 0;
}
static int temporal(void *data) {
  struct unixcall_mtlcommandbuffer_temporal_scale *params = data;
  const struct WMTFXTemporalScalerProps *props = params->props.ptr;
  pthread_once(&resolveCamera, resolve_camera);
  publish_destination(params,props);
  if(@available(macOS 14.4,*))((id<MTLFXTemporalScaler>)params->scaler).reactiveMaskTexture=(id<MTLTexture>)props->reactive_texture;
  if(!publish_scene(params,props)&&clearDestination)clearDestination((void*)params->scaler);
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
