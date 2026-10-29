// Copyright (c) MacLauncher contributors. MIT license.
#import <AppKit/AppKit.h>
#import <QuartzCore/CAMetalLayer.h>
#import <QuartzCore/CAMetalDisplayLink.h>
#import <QuartzCore/CATransaction.h>
#import <OpenGL/OpenGL.h>
#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>
#include "gpu-surface.hpp"
#include "mpv-frame-metadata.h"
#include "presentation.h"
#include "presentation-source.h"
#include "presentation-content.h"
#include "image-color.h"
#include <atomic>
#include <array>
#include <deque>
#include <memory>
#include <vector>
#include <algorithm>
#include <dlfcn.h>
#include <cmath>
#include <cstring>
#include <unistd.h>

#define MPV_SYMBOLS(X) X(mpv_create) X(mpv_initialize) X(mpv_terminate_destroy) X(mpv_set_option_string) X(mpv_load_config_file) X(mpv_request_log_messages) \
 X(mpv_get_property) X(mpv_command_async) X(mpv_wait_event) X(mpv_set_wakeup_callback) X(mpv_get_time_us) X(mpv_free) X(mpv_free_node_contents) X(mpv_observe_property) X(mpv_set_property_async) \
 X(mpv_render_context_create) X(mpv_render_context_set_update_callback) X(mpv_render_context_update) \
 X(mpv_render_context_get_info) X(mpv_render_context_render) X(mpv_render_context_report_swap) X(mpv_render_context_free)
struct MPVAPI {
#define FIELD(name) decltype(&::name) name = nullptr;
 MPV_SYMBOLS(FIELD)
#undef FIELD
 void *library = nullptr;
 decltype(&::mpv_get_time_ns) nanoseconds = nullptr;
 int (*layersAPI)() = nullptr;
 bool load(const char *file) {
  library = dlopen(file, RTLD_NOW | RTLD_LOCAL);if (!library) return false;
#define LOAD(name) name = reinterpret_cast<decltype(name)>(dlsym(library, #name));if (!name) return false;
  MPV_SYMBOLS(LOAD)
#undef LOAD
  nanoseconds = reinterpret_cast<decltype(nanoseconds)>(dlsym(library,"mpv_get_time_ns"));
  layersAPI = reinterpret_cast<decltype(layersAPI)>(dlsym(library,"mpv_mcl_render_layers_api"));
  return true;
 }
};
static NSString *libraryArgument(NSArray<NSString*> *arguments) {
 for(NSString *argument in arguments)if([argument hasPrefix:@"--maclauncher-libmpv="])
  return [argument substringFromIndex:[@"--maclauncher-libmpv=" length]];
 return [[[NSProcessInfo.processInfo.arguments[0] stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"../Frameworks/video/libmpv.2.dylib"] stringByStandardizingPath];
}
static NSApplicationActivationPolicy activationPolicy(NSString *value) {
 return [value isEqualToString:@"accessory"]?NSApplicationActivationPolicyAccessory:[value isEqualToString:@"prohibited"]?NSApplicationActivationPolicyProhibited:NSApplicationActivationPolicyRegular;
}
static NSApplicationActivationPolicy argumentActivationPolicy(NSArray<NSString*> *arguments) {
 NSApplicationActivationPolicy policy=NSApplicationActivationPolicyRegular;
 for(NSString *argument in arguments)if([argument hasPrefix:@"--macos-app-activation-policy="])policy=activationPolicy([argument substringFromIndex:[@"--macos-app-activation-policy=" length]]);
 return policy;
}
static int inspectLibrary(NSArray<NSString*> *arguments) {
 MPVAPI api;if(!api.load(libraryArgument(arguments).fileSystemRepresentation)){fprintf(stderr,"Cannot load the managed libmpv library: %s\n",dlerror());return 1;}
 mpv_handle *mpv=api.mpv_create();if(!mpv)return 1;
 const bool playerScripts=api.mpv_set_option_string(mpv,"osc","no")>=0;
 api.mpv_set_option_string(mpv,"config","no");api.mpv_set_option_string(mpv,"load-scripts","no");api.mpv_set_option_string(mpv,"vo","null");api.mpv_set_option_string(mpv,"ao","null");
 if(api.mpv_initialize(mpv)<0){api.mpv_terminate_destroy(mpv);return 1;}
 char *version=nullptr;api.mpv_get_property(mpv,"mpv-version",MPV_FORMAT_STRING,&version);
 NSMutableArray<NSString*> *filters=[NSMutableArray array];mpv_node node={};
 if(api.mpv_get_property(mpv,"option-info/scale/choices",MPV_FORMAT_NODE,&node)>=0) {
  if(node.format==MPV_FORMAT_NODE_ARRAY)for(int n=0;n<node.u.list->num;n++) {
   const auto &item=node.u.list->values[n];if(item.format==MPV_FORMAT_STRING&&item.u.string)[filters addObject:[NSString stringWithUTF8String:item.u.string]];
  }
  api.mpv_free_node_contents(&node);
 }
 if([arguments containsObject:@"--scale=help"]) {printf("Available scale filters:\n");for(NSString *name in filters)printf("  %s\n",name.UTF8String);}
 else {NSDictionary *info=@{@"schema":@1,@"decodedFrameAPI":@1,@"decodedColorAPI":@1,@"preparationNotificationAPI":@1,@"playerScriptsAPI":@(playerScripts?1:0),@"playerInputAPI":@1,@"osdLayerAPI":@(api.layersAPI&&api.layersAPI()==1?1:0),@"libraryVersion":version?[NSString stringWithUTF8String:version]:@"libmpv",@"scaleFilters":filters};NSData *data=[NSJSONSerialization dataWithJSONObject:info options:0 error:nil];fwrite(data.bytes,1,data.length,stdout);printf("\n");}
 if(version)api.mpv_free(version);api.mpv_terminate_destroy(mpv);return 0;
}
static NSString *applyPlayerOptions(MPVAPI &api,mpv_handle *mpv,NSString *contents) {
 NSString *pattern=[NSTemporaryDirectory() stringByAppendingPathComponent:@"maclauncher-mpv-options-XXXXXX"];
 std::vector<char> temporary(std::strlen(pattern.fileSystemRepresentation)+1);
 std::memcpy(temporary.data(),pattern.fileSystemRepresentation,temporary.size());
 const int descriptor=mkstemp(temporary.data());if(descriptor<0)return @"Cannot create the temporary player configuration.";
 FILE *file=fdopen(descriptor,"wb");
 if(!file){close(descriptor);unlink(temporary.data());return @"Cannot write the temporary player configuration.";}
 NSData *bytes=[contents dataUsingEncoding:NSUTF8StringEncoding];
 const bool written=fwrite(bytes.bytes,1,bytes.length,file)==bytes.length;
 const int closed=fclose(file);
 if(!written||closed!=0){unlink(temporary.data());return @"Cannot write the temporary player configuration.";}
 // libmpv's node setter intentionally excludes CLI aliases and list actions.
 // The upstream configuration parser preserves their order and exact syntax.
 api.mpv_request_log_messages(mpv,"error");
 const int result=api.mpv_load_config_file(mpv,temporary.data());unlink(temporary.data());
 NSMutableArray<NSString*> *errors=[NSMutableArray array];
 for(;;){mpv_event *event=api.mpv_wait_event(mpv,0);if(!event||event->event_id==MPV_EVENT_NONE)break;
  if(event->event_id==MPV_EVENT_LOG_MESSAGE){auto *message=static_cast<mpv_event_log_message*>(event->data);
   if(message&&message->text)[errors addObject:[[NSString stringWithUTF8String:message->text] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]];
  }
 }
 if(errors.count)return [errors componentsJoinedByString:@"\n"];
 return result<0?@"The video player could not read its playback options.":nil;
}
static NSString *applyPlayerOption(MPVAPI &api,mpv_handle *mpv,NSString *name,NSString *value) {
 // Startup options such as config-dir are API options but forbidden in files.
 // Try each original argument directly, then parse only CLI aliases/actions.
 if(api.mpv_set_option_string(mpv,name.UTF8String,value.UTF8String)>=0)return nil;
 NSString *configuration=[NSString stringWithFormat:@"%@=%%%lu%%%@\n",name,(unsigned long)[value lengthOfBytesUsingEncoding:NSUTF8StringEncoding],value];
 return applyPlayerOptions(api,mpv,configuration);
}
struct GraphicsAPI {
 decltype(&rsCreateColorFramePresenter) create = nullptr;
 decltype(&rsSetColorFramePresenterHeadroom) headroom = nullptr;
 decltype(&rsDestroyFramePresenter) destroy = nullptr;
 decltype(&rsSetFramePresenterSource) source = nullptr;
 decltype(&rsObserveFramePresenterPreparation) observe = nullptr;
 decltype(&rsSubmitFramePresenterContentAtTime) submit = nullptr;
 bool load() {
  create = reinterpret_cast<decltype(create)>(dlsym(RTLD_DEFAULT,"rsCreateColorFramePresenter"));
  headroom = reinterpret_cast<decltype(headroom)>(dlsym(RTLD_DEFAULT,"rsSetColorFramePresenterHeadroom"));
  destroy = reinterpret_cast<decltype(destroy)>(dlsym(RTLD_DEFAULT,"rsDestroyFramePresenter"));
  source = reinterpret_cast<decltype(source)>(dlsym(RTLD_DEFAULT,"rsSetFramePresenterSource"));
  observe = reinterpret_cast<decltype(observe)>(dlsym(RTLD_DEFAULT,"rsObserveFramePresenterPreparation"));
  submit = reinterpret_cast<decltype(submit)>(dlsym(RTLD_DEFAULT,"rsSubmitFramePresenterContentAtTime"));
  return create && headroom && destroy && source && observe && submit;
 }
};
struct VideoSlot {
 std::shared_ptr<maclauncher::video::GPUSurface> surface;
 bool busy = false;
};
struct VideoJob {
 unsigned slot;
 uint64_t delivery;
 double target;
 RSPresentationContent content;
};
struct OSDJob {unsigned slot;uint64_t epoch;double target;};
static const mpv_node *mapValue(const mpv_node *node,const char *name) {
 if(!node||node->format!=MPV_FORMAT_NODE_MAP||!node->u.list)return nullptr;
 for(int i=0;i<node->u.list->num;++i)if(node->u.list->keys[i]&&std::strcmp(node->u.list->keys[i],name)==0)return &node->u.list->values[i];
 return nullptr;
}
static double nodeNumber(const mpv_node *node,const char *name) {
 const auto value=mapValue(node,name);return !value?0:value->format==MPV_FORMAT_DOUBLE?value->u.double_:value->format==MPV_FORMAT_INT64?double(value->u.int64):0;
}
static float contentPeak(const mpv_node *params) {
 const auto gamma=mapValue(params,"gamma");const char *transfer=gamma&&gamma->format==MPV_FORMAT_STRING?gamma->u.string:nullptr;
 // These are decoder/filter content values, never the configured target peak.
 double peak=std::max(nodeNumber(params,"max-luma"),nodeNumber(params,"max-cll"));
 if(!std::isfinite(peak)||peak<=0)peak=nodeNumber(params,"sig-peak")*203;
 if(!std::isfinite(peak)||peak<=0)peak=transfer&&std::strcmp(transfer,"pq")==0?10000:transfer&&std::strcmp(transfer,"hlg")==0?1000:203;
 return float(std::clamp(peak,203.0,10000.0));
}
struct VideoSourceState {uint64_t epoch=1,osdEpoch=1;unsigned width=0,height=0,renderWidth=0,renderHeight=0;float peak=10000;};
static bool publishSource(std::shared_ptr<const VideoSourceState>&destination,VideoSourceState next,bool reset=false) {
 const auto previous=std::atomic_load(&destination);
 const bool media=reset||previous->width!=next.width||previous->height!=next.height||previous->peak!=next.peak;
 const bool viewport=previous->renderWidth!=next.renderWidth||previous->renderHeight!=next.renderHeight;
 if(!media&&!viewport)return false;
 next.epoch=previous->epoch+media;next.osdEpoch=previous->osdEpoch+1;std::atomic_store(&destination,std::make_shared<const VideoSourceState>(next));return true;
}
@class MLVideoPlayer;
struct PreparationWake {__weak MLVideoPlayer *player;uint64_t epoch;std::atomic<unsigned>references{1};};
@interface MLVideoView : NSView
@property(nonatomic,weak) MLVideoPlayer *player;
@property(nonatomic,strong) NSTrackingArea *mouseTracking;
@property(nonatomic,strong) NSMutableDictionary<NSNumber*,NSString*> *heldKeys;
@property(nonatomic,strong) NSMutableDictionary<NSNumber*,NSString*> *heldButtons;
- (void)releaseInputs;
@end
@interface MLVideoPlayer : NSObject<NSApplicationDelegate,NSWindowDelegate,CAMetalDisplayLinkDelegate> {
 MPVAPI _api;GraphicsAPI _graphics;
 mpv_handle *_mpv;mpv_render_context *_render;
 CGLContextObj _context;
 dispatch_queue_t _renderQueue,_events;
 id<MTLDevice> _device;id<MTLCommandQueue> _commands,_osdCommands;
 CAMetalLayer *_layer,*_osdLayer;NSWindow *_window;
 CAMetalDisplayLink *_osdDisplayLink;
 void *_presenter;
 PreparationWake *_preparationWake;
 std::array<VideoSlot,3> _slots;
 std::shared_ptr<maclauncher::video::GPUSurface> _redrawSurface;
 std::array<VideoSlot,3> _osdSlots;
 std::deque<VideoJob> _jobs;
 std::deque<OSDJob> _osdJobs;
 std::atomic<bool> _closing,_scheduled,_eventScheduled,_failed;
 std::shared_ptr<const VideoSourceState> _sourceState;
 std::atomic<float> _displayHeadroom;
 uint64_t _presenterEpoch,_delivery,_content,_revision,_retainedVideoEpoch,_retainedOSDEpoch;
 double _clockOffset,_lastDeliveryTime,_osdTarget;
 RSPresentationContent _lastContent,_producedContent;
 bool _timerArmed,_framePending,_osdPending,_videoDirty,_osdDisplayRequested;
 std::string _lastGPUError;
 NSArray<NSString*> *_arguments;
 NSString *_media;
}
- (instancetype)initWithArguments:(NSArray<NSString*>*)arguments;
- (void)requestRender;
- (void)requestEvents;
- (void)resize:(CGSize)size;
- (void)command:(NSArray<NSString*>*)arguments;
- (void)mouseAt:(NSPoint)point;
- (void)reportSwap;
- (void)refreshDisplayHeadroom;
- (void)requestLayout;
- (void)preparationReadyForEpoch:(uint64_t)epoch;
@end
static void retainPreparation(void *context){static_cast<PreparationWake*>(context)->references.fetch_add(1,std::memory_order_relaxed);}
static void releasePreparation(void *context){auto *value=static_cast<PreparationWake*>(context);if(value->references.fetch_sub(1,std::memory_order_acq_rel)==1)delete value;}
static void preparationReady(void *context,const RSFramePreparationNotice *notice){
 (void)notice;auto *value=static_cast<PreparationWake*>(context);MLVideoPlayer *player=value->player;const auto epoch=value->epoch;
 if(player)dispatch_async(dispatch_get_main_queue(),^{[player preparationReadyForEpoch:epoch];});
}
static void updated(void *value) {[(__bridge MLVideoPlayer*)value requestRender];}
static void events(void *value) {[(__bridge MLVideoPlayer*)value requestEvents];}
static void *glAddress(void *,const char *name) {return dlsym(RTLD_DEFAULT,name);}
static std::atomic<uintptr_t> nextPresenterOwner{UINT64_C(0x4d50000000000000)};
struct SurfaceLease {std::shared_ptr<maclauncher::video::GPUSurface> surface;dispatch_queue_t queue;};
static void releaseSurface(void *value) {auto *token=static_cast<SurfaceLease*>(value);dispatch_async(token->queue,^{delete token;});}
struct SwapReceipt {__weak MLVideoPlayer *player;};
static void presented(void *token,uint64_t,double time,double,uint32_t outcome) {
 auto *receipt = static_cast<SwapReceipt*>(token);
 if (time > 0 && outcome == RS_PRESENTED) [receipt->player reportSwap];
 delete receipt;
}
@implementation MLVideoView
- (instancetype)initWithFrame:(NSRect)frame {
 if((self=[super initWithFrame:frame])){self.heldKeys=[NSMutableDictionary dictionary];self.heldButtons=[NSMutableDictionary dictionary];}return self;
}
- (BOOL)acceptsFirstResponder {return YES;}
- (BOOL)acceptsFirstMouse:(NSEvent*)event {(void)event;return YES;}
- (BOOL)wantsUpdateLayer {return YES;}
- (void)layout {[super layout];[self.player resize:[self convertSizeToBacking:self.bounds.size]];}
- (void)viewDidChangeBackingProperties {[super viewDidChangeBackingProperties];[self setNeedsLayout:YES];}
- (void)updateTrackingAreas {
 if(self.mouseTracking)[self removeTrackingArea:self.mouseTracking];
 self.mouseTracking=[[NSTrackingArea alloc]initWithRect:NSZeroRect options:NSTrackingMouseEnteredAndExited|NSTrackingMouseMoved|NSTrackingActiveInKeyWindow|NSTrackingInVisibleRect|NSTrackingEnabledDuringMouseDrag owner:self userInfo:nil];
 [self addTrackingArea:self.mouseTracking];[super updateTrackingAreas];
}
- (NSString*)modifiedKey:(NSString*)key event:(NSEvent*)event {
 NSMutableString *result=[NSMutableString string];const auto modifiers=event.modifierFlags;
 if(modifiers&NSEventModifierFlagShift)[result appendString:@"Shift+"];
 if(modifiers&NSEventModifierFlagControl)[result appendString:@"Ctrl+"];
 if(modifiers&NSEventModifierFlagOption)[result appendString:@"Alt+"];
 if(modifiers&NSEventModifierFlagCommand)[result appendString:@"Meta+"];
 [result appendString:key];return result;
}
- (NSString*)keyForEvent:(NSEvent*)event {
 NSString *key=event.charactersIgnoringModifiers;
 switch(event.keyCode) {
  case 123:key=@"LEFT";break;case 124:key=@"RIGHT";break;case 125:key=@"DOWN";break;case 126:key=@"UP";break;
  case 53:key=@"ESC";break;case 49:key=@"SPACE";break;case 36:key=@"ENTER";break;case 48:key=@"TAB";break;
  case 51:key=@"BS";break;case 117:key=@"DEL";break;case 114:key=@"INS";break;case 115:key=@"HOME";break;
  case 119:key=@"END";break;case 116:key=@"PGUP";break;case 121:key=@"PGDWN";break;case 76:key=@"KP_ENTER";break;
  default:if(key.length==1){unichar code=[key characterAtIndex:0];
   if(code>=NSF1FunctionKey&&code<=NSF24FunctionKey)key=[NSString stringWithFormat:@"F%u",unsigned(code-NSF1FunctionKey+1)];
   else if((event.modifierFlags&NSEventModifierFlagNumericPad)&&code>='0'&&code<='9')key=[@"KP" stringByAppendingString:key];
  }break;
 }
 return key.length?[self modifiedKey:key event:event]:nil;
}
- (void)keyDown:(NSEvent*)event {
 if([NSApp.mainMenu performKeyEquivalent:event]||event.isARepeat)return;
 NSString *key=[self keyForEvent:event];if(!key)return;
 self.heldKeys[@(event.keyCode)]=key;[self.player command:@[@"keydown",key]];
}
- (void)keyUp:(NSEvent*)event {
 NSString *key=self.heldKeys[@(event.keyCode)];if(key){[self.player command:@[@"keyup",key]];[self.heldKeys removeObjectForKey:@(event.keyCode)];}
}
- (void)releaseInputs {[self.player command:@[@"keyup",@""]];[self.heldKeys removeAllObjects];[self.heldButtons removeAllObjects];}
- (void)moveMouse:(NSEvent*)event {[self.player mouseAt:[self convertPoint:event.locationInWindow fromView:nil]];}
- (void)mouseEntered:(NSEvent*)event {[self moveMouse:event];}
- (void)mouseExited:(NSEvent*)event {(void)event;[self.player command:@[@"mouse",@"-1",@"-1"]];}
- (void)mouseMoved:(NSEvent*)event {[self moveMouse:event];}
- (void)mouseDragged:(NSEvent*)event {[self moveMouse:event];}
- (void)rightMouseDragged:(NSEvent*)event {[self moveMouse:event];}
- (void)otherMouseDragged:(NSEvent*)event {[self moveMouse:event];}
- (NSString*)buttonForEvent:(NSEvent*)event {
 NSString *key;
 switch(event.buttonNumber){case 0:key=@"MBTN_LEFT";break;case 1:key=@"MBTN_RIGHT";break;case 2:key=@"MBTN_MID";break;case 3:key=@"MBTN_FORWARD";break;case 4:key=@"MBTN_BACK";break;
  default:key=[NSString stringWithFormat:@"MBTN%ld",long(event.buttonNumber+4)];break;}
 return [self modifiedKey:key event:event];
}
- (void)pressMouse:(NSEvent*)event {
 [self.window makeFirstResponder:self];[self moveMouse:event];
 NSString *key=[self buttonForEvent:event];self.heldButtons[@(event.buttonNumber)]=key;[self.player command:@[@"keydown",key]];
}
- (void)releaseMouse:(NSEvent*)event {
 [self moveMouse:event];NSString *key=self.heldButtons[@(event.buttonNumber)];
 if(key){[self.player command:@[@"keyup",key]];[self.heldButtons removeObjectForKey:@(event.buttonNumber)];}
}
- (void)mouseDown:(NSEvent*)event {[self pressMouse:event];}
- (void)mouseUp:(NSEvent*)event {[self releaseMouse:event];}
- (void)rightMouseDown:(NSEvent*)event {[self pressMouse:event];}
- (void)rightMouseUp:(NSEvent*)event {[self releaseMouse:event];}
- (void)otherMouseDown:(NSEvent*)event {[self pressMouse:event];}
- (void)otherMouseUp:(NSEvent*)event {[self releaseMouse:event];}
- (void)scrollWheel:(NSEvent*)event {
 [self moveMouse:event];const bool precise=event.hasPreciseScrollingDeltas,shift=event.modifierFlags&NSEventModifierFlagShift;
 const double x=precise?event.deltaX*.1:shift?event.scrollingDeltaY:event.scrollingDeltaX;
 const double y=precise?event.deltaY*.1:shift?event.scrollingDeltaX:event.scrollingDeltaY;
 const double delta=std::abs(x)>std::abs(y)?x:y;if(!std::isfinite(delta)||delta==0)return;
 NSString *key=std::abs(x)>std::abs(y)?(x>0?@"WHEEL_LEFT":@"WHEEL_RIGHT"):(y>0?@"WHEEL_UP":@"WHEEL_DOWN");
 [self.player command:@[@"keypress",[self modifiedKey:key event:event],[NSString stringWithFormat:@"%.8f",precise?std::abs(delta):1.]]];
}
@end
@implementation MLVideoPlayer
- (instancetype)initWithArguments:(NSArray<NSString*>*)arguments {
 if (!(self=[super init])) return nil;
 _arguments=arguments;_renderQueue=dispatch_queue_create("org.maclauncher.video.render",DISPATCH_QUEUE_SERIAL);
 _events=dispatch_queue_create("org.maclauncher.video.events",DISPATCH_QUEUE_SERIAL);
 _sourceState=std::make_shared<const VideoSourceState>();_displayHeadroom=1;
 _videoDirty=true;
 return self;
}
- (void)fail:(NSString*)message {
 if(_failed.exchange(true))return;
 fprintf(stderr,"[video] %s\n",message.UTF8String);
 dispatch_async(dispatch_get_main_queue(),^{NSAlert *alert=[NSAlert new];alert.messageText=@"Video playback could not start";alert.informativeText=message;[alert runModal];[NSApp terminate:nil];});
}
- (void)applicationDidFinishLaunching:(NSNotification*)notification {
 (void)notification;
 NSString *library=libraryArgument(_arguments);NSMutableArray<NSString*> *options=[NSMutableArray array];bool media=false;
 for (NSString *argument in _arguments) {
  if ([argument hasPrefix:@"--maclauncher-libmpv="]) continue;
  if ([argument isEqualToString:@"--"]) {media=true;continue;}
  if (media) {_media=argument;break;}
  [options addObject:argument];
 }
 if (!_media || !_api.load(library.fileSystemRepresentation)) {[self fail:@"The selected managed libmpv runtime is unavailable."];return;}
 if (!_graphics.load()) {[self fail:@"The selected graphics runtime does not support decoded video presentation."];return;}
 _device=MTLCreateSystemDefaultDevice();_commands=[_device newCommandQueue];_osdCommands=[_device newCommandQueue];
 _mpv=_api.mpv_create();if(!_mpv||!_commands||!_osdCommands){[self fail:@"Cannot create the video GPU producer."];return;}
 auto option=[&](const char *name,const char *value){return _api.mpv_set_option_string(_mpv,name,value)>=0;};
 option("config","no");option("vo","libmpv");option("hwdec","auto-safe");option("input-default-bindings","yes");
 option("input-vo-keyboard","yes");option("input-cursor","yes");option("fullscreen","no");option("osc","yes");
 for (NSString *argument in options) {
  if(![argument hasPrefix:@"--"])continue;NSString *text=[argument substringFromIndex:2];NSRange equal=[text rangeOfString:@"="];
  NSString *name=equal.location==NSNotFound?text:[text substringToIndex:equal.location],*value=equal.location==NSNotFound?@"yes":[text substringFromIndex:equal.location+1];
  if([name isEqualToString:@"vo"]||[name isEqualToString:@"autofit"]||[name isEqualToString:@"force-window"])continue;
  if([name hasPrefix:@"no-"]&&equal.location==NSNotFound){name=[name substringFromIndex:3];value=@"no";}
  if([name rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"] invertedSet]].location!=NSNotFound||
    [value rangeOfCharacterFromSet:NSCharacterSet.newlineCharacterSet].location!=NSNotFound){[self fail:[@"The video option has an invalid name or line break: " stringByAppendingString:name]];return;}
  if(NSString *error=applyPlayerOption(_api,_mpv,name,value)){[self fail:error];return;}
 }
 // The shared presenter owns the display conversion. Keep this intermediate
 // RGB encoding fixed and independent of the original decoder's transfer.
 if(!option("target-trc","pq")||!option("target-prim","bt.2020")||!option("target-peak","10000")||!option("inverse-tone-mapping","no")){
  [self fail:@"The selected media renderer cannot provide the decoded HDR color contract."];return;
 }
 if(_api.mpv_initialize(_mpv)<0){[self fail:@"Cannot initialize the selected video runtime."];return;}
 char *policy=nullptr;if(_api.mpv_get_property(_mpv,"options/macos-app-activation-policy",MPV_FORMAT_STRING,&policy)>=0&&policy){[NSApp setActivationPolicy:activationPolicy([NSString stringWithUTF8String:policy])];_api.mpv_free(policy);}
 _clockOffset=CACurrentMediaTime()-(_api.nanoseconds?double(_api.nanoseconds(_mpv))*1e-9:double(_api.mpv_get_time_us(_mpv))*1e-6);
 _api.mpv_set_wakeup_callback(_mpv,events,(__bridge void*)self);
 _api.mpv_observe_property(_mpv,1,"fullscreen",MPV_FORMAT_FLAG);
 _api.mpv_observe_property(_mpv,2,"video-out-params",MPV_FORMAT_NODE);
 const char *videoProperties[]={"scale","cscale","dscale","glsl-shaders","glsl-shader-opts","brightness","contrast","saturation","gamma","hue","deband","video-zoom","video-pan-x","video-pan-y","video-rotate"};
 for(unsigned n=0;n<sizeof(videoProperties)/sizeof(videoProperties[0]);++n)_api.mpv_observe_property(_mpv,20+n,videoProperties[n],MPV_FORMAT_NONE);
 _layer=[CAMetalLayer layer];_layer.device=_device;_layer.pixelFormat=MTLPixelFormatRGBA16Float;_layer.framebufferOnly=NO;_layer.wantsExtendedDynamicRangeContent=YES;
 CGColorSpaceRef color=CGColorSpaceCreateWithName(kCGColorSpaceExtendedLinearDisplayP3);_layer.colorspace=color;CGColorSpaceRelease(color);
 _osdLayer=[CAMetalLayer layer];_osdLayer.device=_device;_osdLayer.pixelFormat=MTLPixelFormatBGRA8Unorm;_osdLayer.framebufferOnly=NO;_osdLayer.opaque=NO;_osdLayer.wantsExtendedDynamicRangeContent=NO;
 color=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);_osdLayer.colorspace=color;CGColorSpaceRelease(color);
 _osdDisplayLink=[[CAMetalDisplayLink alloc]initWithMetalLayer:_osdLayer];_osdDisplayLink.delegate=self;_osdDisplayLink.paused=YES;
 [_osdDisplayLink addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
 NSRect screen=NSScreen.mainScreen.visibleFrame;NSRect frame=NSMakeRect(0,0,std::min(1100.0,screen.size.width*.8),std::min(700.0,screen.size.height*.8));
 _window=[[NSWindow alloc]initWithContentRect:frame styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
 _window.title=_media.lastPathComponent;_window.delegate=self;_window.restorable=NO;_window.acceptsMouseMovedEvents=YES;
 MLVideoView *view=[[MLVideoView alloc]initWithFrame:frame];view.player=self;view.wantsLayer=YES;
 view.layer=[CALayer layer];view.layer.backgroundColor=NSColor.blackColor.CGColor;[view.layer addSublayer:_layer];[view.layer addSublayer:_osdLayer];_window.contentView=view;
 [_window center];[_window makeFirstResponder:view];
 if(NSApp.activationPolicy==NSApplicationActivationPolicyRegular){[_window makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];}
 else [_window orderBack:nil];
 [view setNeedsLayout:YES];
 [self refreshDisplayHeadroom];
 dispatch_async(_renderQueue,^{@autoreleasepool {
  CGLPixelFormatAttribute attributes[]={kCGLPFAAccelerated,kCGLPFAOpenGLProfile,(CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,(CGLPixelFormatAttribute)0};
  CGLPixelFormatObj format;GLint count=0;CGLError error=CGLChoosePixelFormat(attributes,&format,&count);
  if(error==kCGLNoError){error=CGLCreateContext(format,nullptr,&self->_context);CGLReleasePixelFormat(format);}
  if(error!=kCGLNoError){[self fail:@"Cannot create the decoded video GPU context."];return;}
  CGLSetCurrentContext(self->_context);int advanced=1;mpv_opengl_init_params gl={glAddress,nullptr};
  mpv_render_param params[]={{MPV_RENDER_PARAM_API_TYPE,(void*)MPV_RENDER_API_TYPE_OPENGL},{MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,&gl},{MPV_RENDER_PARAM_ADVANCED_CONTROL,&advanced},{MPV_RENDER_PARAM_INVALID,nullptr}};
  if(self->_api.mpv_render_context_create(&self->_render,self->_mpv,params)<0){[self fail:@"Cannot initialize the decoded video renderer."];return;}
  int layers=0;if(!self->_api.layersAPI||self->_api.layersAPI()!=1||self->_api.mpv_render_context_get_info(self->_render,{(mpv_render_param_type)ML_MPV_RENDER_INFO_LAYERS,&layers})<0||layers!=1){[self fail:@"The selected media library cannot render player controls independently of video effects. Install a current decoded video runtime."];return;}
  self->_api.mpv_render_context_set_update_callback(self->_render,updated,(__bridge void*)self);
  [self command:@[@"loadfile",self->_media]];
 }});
}
- (void)command:(NSArray<NSString*>*)arguments {
 if(_closing)return;
 dispatch_async(_events,^{if(self->_closing||!self->_mpv)return;
  std::vector<const char*> values;for(NSString *value in arguments)values.push_back(value.UTF8String);values.push_back(nullptr);
  self->_api.mpv_command_async(self->_mpv,0,values.data());
 });
}
- (void)mouseAt:(NSPoint)point {
 const CGRect frame=_osdLayer.frame;const auto source=std::atomic_load(&_sourceState);
 if(frame.size.width<=0||frame.size.height<=0||!source->renderWidth||!source->renderHeight)return;
 const double x=(point.x-frame.origin.x)*source->renderWidth/frame.size.width;
 const double y=(CGRectGetMaxY(frame)-point.y)*source->renderHeight/frame.size.height;
 [self command:@[@"mouse",[NSString stringWithFormat:@"%d",int(std::floor(x))],[NSString stringWithFormat:@"%d",int(std::floor(y))]]];
}
- (void)reportSwap {
 if(_closing)return;
 dispatch_async(_renderQueue,^{if(self->_render&&!self->_closing)self->_api.mpv_render_context_report_swap(self->_render);});
}
- (void)requestEvents {
 if(_closing||_eventScheduled.exchange(true))return;
 dispatch_async(_events,^{self->_eventScheduled=false;if(self->_closing||!self->_mpv)return;
  for(;;){mpv_event *event=self->_api.mpv_wait_event(self->_mpv,0);if(!event||event->event_id==MPV_EVENT_NONE)break;
   if(event->event_id==MPV_EVENT_SHUTDOWN){dispatch_async(dispatch_get_main_queue(),^{[NSApp terminate:nil];});break;}
   if(event->event_id==MPV_EVENT_CLIENT_MESSAGE){auto *message=static_cast<mpv_event_client_message*>(event->data);
    if(message&&message->num_args>0&&std::strcmp(message->args[0],"maclauncher-video-redraw")==0)[self markVideoDirty];
   }
   if(event->event_id==MPV_EVENT_START_FILE){const auto previous=std::atomic_load(&self->_sourceState);VideoSourceState next;next.renderWidth=previous->renderWidth;next.renderHeight=previous->renderHeight;publishSource(self->_sourceState,next,true);}
   if(event->event_id==MPV_EVENT_SEEK)publishSource(self->_sourceState,*std::atomic_load(&self->_sourceState),true);
   if(event->event_id==MPV_EVENT_PROPERTY_CHANGE){auto *property=static_cast<mpv_event_property*>(event->data);
    if(event->reply_userdata>=20&&event->reply_userdata<35)[self markVideoDirty];
    if(property&&property->name&&std::strcmp(property->name,"fullscreen")==0&&property->format==MPV_FORMAT_FLAG&&property->data){
     const bool full=*static_cast<int*>(property->data)!=0;dispatch_async(dispatch_get_main_queue(),^{if(self->_window&&bool(self->_window.styleMask&NSWindowStyleMaskFullScreen)!=full)[self->_window toggleFullScreen:nil];});
    }
    if(property&&property->name&&std::strcmp(property->name,"video-out-params")==0&&property->format==MPV_FORMAT_NODE&&property->data){
     auto next=*std::atomic_load(&self->_sourceState);next.peak=contentPeak(static_cast<const mpv_node*>(property->data));if(publishSource(self->_sourceState,next))[self requestRender];
    }
   }
   if(event->event_id==MPV_EVENT_VIDEO_RECONFIG||event->event_id==MPV_EVENT_FILE_LOADED){
    [self markVideoDirty];
    auto next=*std::atomic_load(&self->_sourceState);
    mpv_node params={};if(self->_api.mpv_get_property(self->_mpv,"video-out-params",MPV_FORMAT_NODE,&params)>=0){next.peak=contentPeak(&params);self->_api.mpv_free_node_contents(&params);}
    int64_t w=0,h=0;self->_api.mpv_get_property(self->_mpv,"dwidth",MPV_FORMAT_INT64,&w);self->_api.mpv_get_property(self->_mpv,"dheight",MPV_FORMAT_INT64,&h);
    if(w>0&&h>0&&w<=16384&&h<=16384){next.width=(unsigned)w;next.height=(unsigned)h;publishSource(self->_sourceState,next);[self requestLayout];[self requestRender];}
   }
  }
 });
}
- (void)resize:(CGSize)size {
 if(size.width<1||size.height<1)return;
 const CGSize viewport=size;
 const auto source=std::atomic_load(&_sourceState);
 if(source->width&&source->height){const double scale=std::min(size.width/source->width,size.height/source->height);size=CGSizeMake(std::max(1.,std::round(source->width*scale)),std::max(1.,std::round(source->height*scale)));}
 const double backing=std::max(1.,_window.backingScaleFactor);const NSRect bounds=_window.contentView.bounds;
 [CATransaction begin];[CATransaction setDisableActions:YES];
 _layer.contentsScale=backing;_layer.frame=CGRectMake((bounds.size.width-size.width/backing)*.5,(bounds.size.height-size.height/backing)*.5,size.width/backing,size.height/backing);_layer.drawableSize=size;
 _osdLayer.contentsScale=backing;_osdLayer.frame=bounds;_osdLayer.drawableSize=viewport;
 [CATransaction commit];
 [self refreshDisplayHeadroom];
 const unsigned renderWidth=(unsigned)std::round(viewport.width),renderHeight=(unsigned)std::round(viewport.height);
 dispatch_async(_events,^{
  if(self->_closing)return;
  auto next=*std::atomic_load(&self->_sourceState);next.renderWidth=renderWidth;next.renderHeight=renderHeight;
  if(publishSource(self->_sourceState,next)){
   dispatch_async(self->_renderQueue,^{self->_osdPending=true;[self pump];});[self command:@[@"osd-overlay",@"0",@"ass-events",@""]];
  }
 });
}
- (void)requestLayout {dispatch_async(dispatch_get_main_queue(),^{if(!self->_closing)[self->_window.contentView setNeedsLayout:YES];});}
- (void)refreshDisplayHeadroom {
 const float actual=float((_window.screen?:NSScreen.mainScreen).maximumExtendedDynamicRangeColorComponentValue);
 _displayHeadroom=std::isfinite(actual)?std::clamp(actual,1.f,100.f):1.f;
}
- (void)windowDidChangeScreen:(NSNotification*)notification {(void)notification;[self refreshDisplayHeadroom];[self command:@[@"osd-overlay",@"0",@"ass-events",@""]];}
- (void)applicationDidChangeScreenParameters:(NSNotification*)notification {
 [self windowDidChangeScreen:notification];
}
- (BOOL)createPresenter:(const VideoSourceState*)source {
 if(_presenter&&_presenterEpoch==source->epoch){_graphics.headroom(_presenter,_displayHeadroom.load());return YES;}
 if(_presenter){_graphics.observe(_presenter,nullptr);_graphics.destroy(_presenter);}
 if(_preparationWake){releasePreparation(_preparationWake);_preparationWake=nullptr;}
 _presenter=nullptr;_presenterEpoch=source->epoch;_lastContent={};_producedContent={};_content=0;_videoDirty=true;
 // Owners are opaque registry keys. Never reuse one across a seek; old GPU
 // callbacks retain their own storage while their presentation epoch retires.
 void *owner=reinterpret_cast<void*>(nextPresenterOwner.fetch_add(1));
 RSPresenterOptions options={sizeof(options),1,RS_FRAME_BOTTOM_LEFT,0,0};RSPresenterError error={sizeof(error),1,{}};
 RSImageColorDescription color={sizeof(color),1,RS_COLOR_BT2020,RS_COLOR_PQ,RS_COLOR_FULL,RS_COLOR_OPAQUE,203,source->peak,0,1.2f,0,0};
 _presenter=_graphics.create((__bridge void*)_layer,owner,&options,&color,_displayHeadroom.load(),&error);
 if(!_presenter){[self fail:[NSString stringWithUTF8String:error.reason]];return NO;}
 _preparationWake=new PreparationWake{self,_presenterEpoch};
 RSFramePreparationObserver observer={sizeof(observer),1,_preparationWake,preparationReady,retainPreparation,releasePreparation};
 if(_graphics.observe(_presenter,&observer)!=RS_FRAME_OK){[self fail:@"The graphics runtime cannot coordinate video resource preparation."];return NO;}
 _graphics.source(_presenter,RS_FRAME_SOURCE_DECODED_VIDEO);return YES;
}
- (void)preparationReadyForEpoch:(uint64_t)epoch {
 if(_closing)return;
 dispatch_async(_renderQueue,^{
  if(self->_closing||self->_failed||self->_presenterEpoch!=epoch)return;
  self->_videoDirty=true;
  if(!self->_jobs.empty()||self->_framePending)[self pump];
  else [self command:@[@"osd-overlay",@"0",@"ass-events",@""]];
 });
}
- (void)markVideoDirty {
 if(_closing)return;
 dispatch_async(_renderQueue,^{if(!self->_closing)self->_videoDirty=true;});
 [self command:@[@"osd-overlay",@"0",@"ass-events",@""]];
}
- (void)requestRender {
 if(_closing||_scheduled.exchange(true))return;
 dispatch_async(_renderQueue,^{self->_scheduled=false;[self pump];});
}
- (void)again {
 if(_timerArmed||_closing)return;_timerArmed=true;
 dispatch_after(dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_MSEC),_renderQueue,^{self->_timerArmed=false;[self pump];});
}
- (void)flushOSDJobs:(const VideoSourceState*)source {
 while(!_osdJobs.empty()){
  const auto job=_osdJobs.front();auto &slot=_osdSlots[job.slot];
  if(!slot.surface->ready()){[self again];break;}
  if(job.epoch==source->osdEpoch)break;
  _osdJobs.pop_front();slot.busy=false;
 }
 const bool requested=!_osdJobs.empty();if(requested==_osdDisplayRequested)return;_osdDisplayRequested=requested;
 dispatch_async(dispatch_get_main_queue(),^{if(!self->_closing)self->_osdDisplayLink.paused=!requested;});
}
- (void)metalDisplayLink:(CAMetalDisplayLink*)link needsUpdate:(CAMetalDisplayLinkUpdate*)update {
 (void)link;if(_closing)return;id<CAMetalDrawable> drawable=update.drawable;const double target=update.targetPresentationTimestamp;
 dispatch_async(_renderQueue,^{if(!self->_closing)[self presentOSD:drawable target:target];});
}
- (void)presentOSD:(id<CAMetalDrawable>)drawable target:(double)target {
 (void)target;
 CGLSetCurrentContext(_context);const auto source=std::atomic_load(&_sourceState);[self flushOSDJobs:source.get()];
 if(_osdJobs.empty()||!drawable)return;
 const auto job=_osdJobs.front();auto &slot=_osdSlots[job.slot];
 if(!slot.surface->ready()){[self again];return;}
 if(drawable.texture.width!=slot.surface->width()||drawable.texture.height!=slot.surface->height())return;
 _osdJobs.pop_front();auto *lease=new SurfaceLease{slot.surface,_renderQueue};
 id<MTLCommandBuffer> commands=[_osdCommands commandBuffer];id<MTLBlitCommandEncoder> copy=[commands blitCommandEncoder];
 if(!commands||!copy){slot.busy=false;delete lease;[self fail:@"Cannot copy the player controls to the display."];return;}
 [copy copyFromTexture:lease->surface->texture() sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0)
   sourceSize:MTLSizeMake(lease->surface->width(),lease->surface->height(),1) toTexture:drawable.texture destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
 [copy endEncoding];[commands presentDrawable:drawable];
 [commands addCompletedHandler:^(id<MTLCommandBuffer> finished){
  if(finished.status==MTLCommandBufferStatusError)[self fail:finished.error.localizedDescription?:@"Player control presentation failed."];
  dispatch_async(self->_renderQueue,^{self->_osdSlots[job.slot].busy=false;delete lease;if(!self->_closing)[self pump];});
 }];
 [commands commit];[self flushOSDJobs:source.get()];
}
- (void)renderOSD:(const VideoSourceState*)source {
 [self flushOSDJobs:source];
 if(!_osdPending||_retainedVideoEpoch!=source->epoch||_retainedOSDEpoch!=source->osdEpoch)return;
 auto free=std::find_if(_osdSlots.begin(),_osdSlots.end(),[](const auto &slot){return !slot.busy;});
 if(free==_osdSlots.end())return;
 std::string error;
 if(!free->surface||free->surface->width()!=source->renderWidth||free->surface->height()!=source->renderHeight){
  auto surface=maclauncher::video::GPUSurface::create(_device,source->renderWidth,source->renderHeight,false,error);
  if(!surface){[self fail:[NSString stringWithUTF8String:error.c_str()]];return;}free->surface=std::move(surface);
 }
 mpv_opengl_fbo fbo={(int)free->surface->framebuffer(),(int)source->renderWidth,(int)source->renderHeight,GL_RGBA8};int flip=0,block=0;
 MLMpvRenderLayers layers={sizeof(layers),1,ML_MPV_LAYER_OSD,0,source->renderWidth,source->renderHeight,1};
 mpv_render_param params[]={{MPV_RENDER_PARAM_OPENGL_FBO,&fbo},{MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME,&block},{MPV_RENDER_PARAM_FLIP_Y,&flip},
  {(mpv_render_param_type)ML_MPV_RENDER_PARAM_LAYERS,&layers},{MPV_RENDER_PARAM_INVALID,nullptr}};
 if(_api.mpv_render_context_render(_render,params)<0){[self fail:@"The media renderer could not draw the independent player controls."];return;}
 _osdPending=false;free->surface->produced();free->busy=true;
 _osdJobs.push_back({(unsigned)std::distance(_osdSlots.begin(),free),source->osdEpoch,_osdTarget});[self again];
}
- (void)pump {
 if(_closing||_failed||!_render)return;CGLSetCurrentContext(_context);
 const uint64_t updates=_api.mpv_render_context_update(_render);
 if(updates&MPV_RENDER_UPDATE_FRAME){_framePending=true;_osdPending=true;}
 const auto source=std::atomic_load(&_sourceState);
 // Metadata and the first render update arrive on separate queues. Retain the
 // pending image until its dimensions arrive; consuming it here loses the only
 // image of an initially paused stream. The metadata event requests the retry.
 if(!source->width||!source->height||!source->renderWidth||!source->renderHeight)return;
 if(![self createPresenter:source.get()])return;
 [self flushOSDJobs:source.get()];
 while(!_jobs.empty()) {
  auto job=_jobs.front();auto &slot=_slots[job.slot];if(!slot.surface->ready()){[self again];break;}
  if(job.content.epoch!=_presenterEpoch){slot.busy=false;_jobs.pop_front();continue;}
  id<MTLCommandBuffer> commands=[_commands commandBuffer];
  auto *lease=new SurfaceLease{slot.surface,_renderQueue};
  auto *receipt=new SwapReceipt{self};
  RSPresenterSubmission submission={sizeof(submission),1,(__bridge void*)commands,(__bridge void*)slot.surface->texture(),job.delivery,
    std::max(CACurrentMediaTime(),_lastDeliveryTime+1e-6),lease,releaseSurface};
  RSPresentationTarget target={sizeof(target),1,job.target};
  RSPresentationObserver observer={sizeof(observer),1,receipt,presented};RSFrameResult result={sizeof(result),1};
  const int code=_graphics.submit(_presenter,&submission,&job.content,&target,&observer,&result);
  if(code!=RS_FRAME_OK){delete lease;delete receipt;}
  if(code==RS_FRAME_BUSY){[commands commit];[self again];break;}
  _jobs.pop_front();
  if(code==RS_FRAME_OK){_lastContent=job.content;_lastDeliveryTime=submission.sourceTime;_lastGPUError.clear();}
  else if(_lastGPUError!=result.reason){_lastGPUError=result.reason;fprintf(stderr,"[video] GPU submission: %s\n",result.reason);}
  const unsigned index=job.slot;
  [commands addCompletedHandler:^(id<MTLCommandBuffer>){dispatch_async(self->_renderQueue,^{self->_slots[index].busy=false;[self pump];});}];
  [commands commit];
 }
 if(!_framePending){[self renderOSD:source.get()];return;}
 mpv_render_frame_info info={};_api.mpv_render_context_get_info(_render,{MPV_RENDER_PARAM_NEXT_FRAME_INFO,&info});
 if(!(info.flags&MPV_RENDER_FRAME_INFO_PRESENT)){_framePending=false;[self renderOSD:source.get()];return;}
 const bool redraw=(info.flags&(MPV_RENDER_FRAME_INFO_REDRAW|MPV_RENDER_FRAME_INFO_REPEAT))&&(_lastContent.contentId||_content);
 MLMpvFrameMetadata metadata={sizeof(metadata),1};
 const bool exact=_api.mpv_render_context_get_info(_render,{(mpv_render_param_type)ML_MPV_RENDER_PARAM_FRAME_METADATA,&metadata})>=0&&(metadata.flags&ML_MPV_FRAME_PRESENT);
 const bool videoChanged=!redraw||_videoDirty||(exact&&metadata.contentId!=_producedContent.contentId);
 auto free=std::find_if(_slots.begin(),_slots.end(),[](const auto &slot){return !slot.busy;});
 if(videoChanged&&free==_slots.end()){[self renderOSD:source.get()];return;}
 std::string error;
 auto &surface=videoChanged?free->surface:_redrawSurface;
 if(!surface||surface->width()!=source->width||surface->height()!=source->height) {
  auto allocated=maclauncher::video::GPUSurface::create(_device,source->width,source->height,true,error);
  if(!allocated){[self fail:[NSString stringWithUTF8String:error.c_str()]];return;}surface=std::move(allocated);
 }
 mpv_opengl_fbo fbo={(int)surface->framebuffer(),(int)source->width,(int)source->height,GL_RGBA16F};int block=0,flip=0;
 MLMpvRenderLayers layers={sizeof(layers),1,ML_MPV_LAYER_VIDEO,0,source->renderWidth,source->renderHeight,1};
 mpv_render_param params[]={{MPV_RENDER_PARAM_OPENGL_FBO,&fbo},{MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME,&block},{MPV_RENDER_PARAM_FLIP_Y,&flip},
  {(mpv_render_param_type)ML_MPV_RENDER_PARAM_LAYERS,&layers},{MPV_RENDER_PARAM_INVALID,nullptr}};
 if(_api.mpv_render_context_render(_render,params)<0){fprintf(stderr,"[video] Decoded GPU rendering failed.\n");return;}
 _framePending=false;_retainedVideoEpoch=source->epoch;_retainedOSDEpoch=source->osdEpoch;_osdPending=true;
 const double target=info.target_time>0?_clockOffset+double(info.target_time)*(_api.nanoseconds?1e-9:1e-6):CACurrentMediaTime();_osdTarget=target;
 if(!videoChanged){[self renderOSD:source.get()];return;}
 _videoDirty=false;surface->produced();
 if(!redraw)_content++;
 // This is the producer's processing revision, not a per-frame counter.
 // Changing it on every decoded image would reset interpolation history.
 if(!_revision)_revision=1;else if(redraw)++_revision;
 RSPresentationContent content={sizeof(content),1,(uint32_t)((redraw?RS_PRESENT_CONTENT_REDRAW:0)|(!exact||(metadata.flags&ML_MPV_FRAME_PTS_UNKNOWN)?RS_PRESENT_CONTENT_PTS_UNKNOWN:0)),0,
  exact?metadata.contentId:redraw?_producedContent.contentId:_content,_presenterEpoch,_revision,exact?metadata.pts:0,exact?metadata.duration:0};
 _producedContent=content;free->busy=true;_jobs.push_back({(unsigned)std::distance(_slots.begin(),free),++_delivery,target,content});[self renderOSD:source.get()];[self again];
}
- (void)setFullscreen:(BOOL)full {
 dispatch_async(_events,^{if(!self->_closing&&self->_mpv){int value=full;self->_api.mpv_set_property_async(self->_mpv,2,"fullscreen",MPV_FORMAT_FLAG,&value);}});
}
- (void)windowDidEnterFullScreen:(NSNotification*)notification {(void)notification;[self setFullscreen:YES];}
- (void)windowDidExitFullScreen:(NSNotification*)notification {(void)notification;[self setFullscreen:NO];}
- (void)windowDidResignKey:(NSNotification*)notification {(void)notification;[(MLVideoView*)_window.contentView releaseInputs];}
- (BOOL)applicationShouldHandleReopen:(NSApplication*)application hasVisibleWindows:(BOOL)visible {
 (void)application;(void)visible;if(_window){[_window deminiaturize:nil];if(NSApp.activationPolicy==NSApplicationActivationPolicyRegular)[_window makeKeyAndOrderFront:nil];else [_window orderBack:nil];}return YES;
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)application {(void)application;return YES;}
- (void)applicationWillTerminate:(NSNotification*)notification {
 (void)notification;_closing=true;
 [_osdDisplayLink invalidate];_osdDisplayLink=nil;
 if(_mpv)_api.mpv_set_wakeup_callback(_mpv,nullptr,nullptr);
 dispatch_sync(_renderQueue,^{
  CGLSetCurrentContext(self->_context);
  if(self->_render){self->_api.mpv_render_context_set_update_callback(self->_render,nullptr,nullptr);self->_api.mpv_render_context_free(self->_render);self->_render=nullptr;}
  if(self->_presenter){self->_graphics.observe(self->_presenter,nullptr);self->_graphics.destroy(self->_presenter);self->_presenter=nullptr;}
  if(self->_preparationWake){releasePreparation(self->_preparationWake);self->_preparationWake=nullptr;}
  self->_jobs.clear();self->_osdJobs.clear();self->_redrawSurface.reset();for(auto &slot:self->_slots)slot.surface.reset();for(auto &slot:self->_osdSlots)slot.surface.reset();
  if(self->_context){CGLSetCurrentContext(nullptr);CGLReleaseContext(self->_context);self->_context=nullptr;}
 });
 dispatch_sync(_events,^{if(self->_mpv){self->_api.mpv_terminate_destroy(self->_mpv);self->_mpv=nullptr;}});
}
@end
int main(int argc,const char **argv) {
 @autoreleasepool {
  // The graphics core is a separate package that can load after this point:
  // the environment covers a later load, the setter a core that already read it.
  setenv("RESHADE_EXPLICIT_HOST","1",1);
  if(const auto explicitHost=reinterpret_cast<int(*)(uint32_t,int)>(dlsym(RTLD_DEFAULT,"rsSetExplicitHost")))explicitHost(1,1);
  NSMutableArray<NSString*> *arguments=[NSMutableArray array];for(int n=1;n<argc;n++)[arguments addObject:[NSString stringWithUTF8String:argv[n]]];
  if([arguments containsObject:@"--maclauncher-info"]||[arguments containsObject:@"--scale=help"])return inspectLibrary(arguments);
  NSApplication *application=NSApplication.sharedApplication;[application setActivationPolicy:argumentActivationPolicy(arguments)];
  NSMenu *menu=[NSMenu new],*appMenu=[NSMenu new];NSMenuItem *item=[NSMenuItem new];item.submenu=appMenu;[menu addItem:item];
  [appMenu addItemWithTitle:@"Quit" action:@selector(terminate:) keyEquivalent:@"q"];application.mainMenu=menu;
  NSMenu *file=[NSMenu new];NSMenuItem *fileItem=[NSMenuItem new];fileItem.title=@"File";fileItem.submenu=file;[menu addItem:fileItem];
  [file addItemWithTitle:@"Close" action:@selector(performClose:) keyEquivalent:@"w"];
  NSMenu *view=[NSMenu new];NSMenuItem *viewItem=[NSMenuItem new];viewItem.title=@"View";viewItem.submenu=view;[menu addItem:viewItem];
  NSMenuItem *fullscreen=[view addItemWithTitle:@"Enter Full Screen" action:@selector(toggleFullScreen:) keyEquivalent:@"f"];fullscreen.keyEquivalentModifierMask=NSEventModifierFlagCommand|NSEventModifierFlagControl;
  NSMenu *window=[NSMenu new];NSMenuItem *windowItem=[NSMenuItem new];windowItem.title=@"Window";windowItem.submenu=window;[menu addItem:windowItem];
  [window addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];[window addItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""];
  [window addItem:[NSMenuItem separatorItem]];[window addItemWithTitle:@"Bring All to Front" action:@selector(arrangeInFront:) keyEquivalent:@""];application.windowsMenu=window;
  MLVideoPlayer *player=[[MLVideoPlayer alloc]initWithArguments:arguments];application.delegate=player;[application run];
 }
 return 0;
}
