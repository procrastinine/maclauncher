#import <Cocoa/Cocoa.h>
#define VK_NO_PROTOTYPES
#define VK_USE_PLATFORM_ANDROID_KHR 1
#include <vulkan/vulkan.h>
#include <vector>
#include <atomic>
#include "presentation.mm"

@interface VulkanOutput:CAMetalLayer
@property(strong) id<CAMetalDrawable> captured;
@end
@implementation VulkanOutput
-(id<CAMetalDrawable>)nextDrawable{auto result=[super nextDrawable];self.captured=result;return result;}
@end
struct Fixture {JNIEnv *env;JavaVM *vm;NSWindow *window=nil;Presenter *presenter;void *carrier=nullptr;id<MTLBuffer> producerPixels;std::atomic<unsigned> complete{0};};
static int frame(void *context,void *commands,void *image){@autoreleasepool{
    auto state=(Fixture*)context;JNIEnv *env=nullptr;bool attached=state->vm->GetEnv((void**)&env,JNI_VERSION_1_8)==JNI_EDETACHED;
    if(attached)state->vm->AttachCurrentThreadAsDaemon((void**)&env,nullptr);
    auto cb=(__bridge id<MTLCommandBuffer>)commands;auto texture=(__bridge id<MTLTexture>)image;
    state->producerPixels=[texture.device newBufferWithLength:256 options:MTLResourceStorageModeShared];auto copy=[cb blitCommandEncoder];
    [copy copyFromTexture:texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:state->producerPixels destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:256];[copy endEncoding];
    int result=klj_metal_native_frame(env,state->presenter,commands,image);
    if(env->ExceptionCheck()){env->ExceptionDescribe();env->ExceptionClear();result=4;}
    if(result==0)[(__bridge id<MTLCommandBuffer>)commands addCompletedHandler:^(id<MTLCommandBuffer>){++state->complete;}];
    if(attached)state->vm->DetachCurrentThread();return result==0;
}}
static int acquire(void *window,void **context,void **layer){auto state=(Fixture*)window;if(getenv("VULKAN_TEST_RAW_WSI")){auto raw=[VulkanOutput layer];raw.drawableSize=CGSizeMake(64,48);raw.bounds=CGRectMake(0,0,64,48);raw.framebufferOnly=NO;raw.device=MTLCreateSystemDefaultDevice();if(getenv("VULKAN_TEST_ATTACHED")){[NSApplication sharedApplication];state->window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,64,48)styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];state->window.releasedWhenClosed=NO;state->window.contentView.wantsLayer=YES;state->window.contentView.layer=raw;[state->window orderBack:nil];[state->window display];}state->carrier=(__bridge_retained void*)raw;*context=state;*layer=state->carrier;return 1;}state->carrier=klj_metal_native_layer(state->env,64,48,frame,state);*context=state;*layer=state->carrier;return state->carrier!=nullptr;}
static void release(void *context){auto state=(Fixture*)context;if(getenv("VULKAN_TEST_RAW_WSI"))CFBridgingRelease(state->carrier);else klj_metal_release_native_layer(state->carrier);if(state->window)[state->window close];state->carrier=nullptr;}
static void success(VkResult result,const char *name){if(result!=VK_SUCCESS)throw std::runtime_error(std::string(name)+" returned "+std::to_string(result));}
extern "C" JNIEXPORT void JNICALL Java_VulkanPresentationProbe_run(JNIEnv *env,jclass,jstring path){@autoreleasepool{try{
    const char *filename=env->GetStringUTFChars(path,nullptr);auto library=dlopen(filename,RTLD_NOW|RTLD_LOCAL);env->ReleaseStringUTFChars(path,filename);check(library,dlerror()?:"Vulkan bridge load failed");
    auto lookup=(void*(*)(const char*))dlsym(library,"kl_vulkan_sym");check(lookup,"Original Vulkan adapter export missing");
    auto version=(jint(*)(JNIEnv*,jclass))dlsym(library,"Java_maclauncher_android_bridge_Graphics_vulkanVersion");check(version,"Native Vulkan capability query missing");
    unsigned measured=version(env,nullptr);check(measured>=VK_API_VERSION_1_0&&measured==unsigned(version(env,nullptr)),"Vulkan capability query did not measure a stable driver version");
    auto setBridge=(int(*)(int(*)(void*,void**,void**),void(*)(void*)))dlsym(library,"klj_vulkan_set_window_bridge");check(setBridge&&setBridge(acquire,release),"Vulkan window callbacks failed");
    auto get=(PFN_vkGetInstanceProcAddr)lookup("vkGetInstanceProcAddr");check(get,"No Vulkan loader");
    VkApplicationInfo application{VK_STRUCTURE_TYPE_APPLICATION_INFO};application.apiVersion=VK_API_VERSION_1_1;
    const char *extensions[]={"VK_KHR_surface","VK_KHR_android_surface"};VkInstanceCreateInfo instanceInfo{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};instanceInfo.pApplicationInfo=&application;instanceInfo.enabledExtensionCount=2;instanceInfo.ppEnabledExtensionNames=extensions;
    VkInstance instance;success(((PFN_vkCreateInstance)get(nullptr,"vkCreateInstance"))(&instanceInfo,nullptr,&instance),"vkCreateInstance");
    check(!get(instance,"vkMacLauncherMissingFunction"),"Missing Vulkan entry point returned a false-success stub");
    const char *absent[]={"VK_MACLAUNCHER_missing_extension"};auto unsupported=instanceInfo;unsupported.enabledExtensionCount=1;unsupported.ppEnabledExtensionNames=absent;
    VkInstance rejected=VK_NULL_HANDLE;check(((PFN_vkCreateInstance)get(nullptr,"vkCreateInstance"))(&unsupported,nullptr,&rejected)==VK_ERROR_EXTENSION_NOT_PRESENT,"Requested Vulkan extension was silently discarded");
    #define INSTANCE(name) ((PFN_##name)get(instance,#name))
    auto output=[VulkanOutput layer];output.bounds=CGRectMake(0,0,64,48);output.contentsScale=1;
    Fixture state{env};env->GetJavaVM(&state.vm);state.presenter=(Presenter*)klj_metal_create(env,(__bridge void*)output,64,48);check(state.presenter,"Presenter creation failed");
    VkAndroidSurfaceCreateInfoKHR surfaceInfo{VK_STRUCTURE_TYPE_ANDROID_SURFACE_CREATE_INFO_KHR};surfaceInfo.window=(ANativeWindow*)&state;
    VkSurfaceKHR surface;success(INSTANCE(vkCreateAndroidSurfaceKHR)(instance,&surfaceInfo,nullptr,&surface),"vkCreateAndroidSurfaceKHR");
    uint32_t count=0;success(INSTANCE(vkEnumeratePhysicalDevices)(instance,&count,nullptr),"vkEnumeratePhysicalDevices");check(count,"No GPU");std::vector<VkPhysicalDevice> devices(count);success(INSTANCE(vkEnumeratePhysicalDevices)(instance,&count,devices.data()),"vkEnumeratePhysicalDevices");auto physical=devices[0];
    VkPhysicalDeviceProperties properties;INSTANCE(vkGetPhysicalDeviceProperties)(physical,&properties);check(measured<=properties.apiVersion,"Advertised Vulkan version exceeds physical device");
    INSTANCE(vkGetPhysicalDeviceQueueFamilyProperties)(physical,&count,nullptr);std::vector<VkQueueFamilyProperties> families(count);INSTANCE(vkGetPhysicalDeviceQueueFamilyProperties)(physical,&count,families.data());uint32_t family=count;
    for(uint32_t i=0;i<count;i++){VkBool32 supported=0;success(INSTANCE(vkGetPhysicalDeviceSurfaceSupportKHR)(physical,i,surface,&supported),"vkGetPhysicalDeviceSurfaceSupportKHR");if(supported&&(families[i].queueFlags&VK_QUEUE_GRAPHICS_BIT)){family=i;break;}}check(family<count,"No presentation queue");
    float priority=1;VkDeviceQueueCreateInfo queueInfo{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};queueInfo.queueFamilyIndex=family;queueInfo.queueCount=1;queueInfo.pQueuePriorities=&priority;
    const char *deviceExtensions[]={"VK_KHR_swapchain"};VkDeviceCreateInfo deviceInfo{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};deviceInfo.queueCreateInfoCount=1;deviceInfo.pQueueCreateInfos=&queueInfo;deviceInfo.enabledExtensionCount=1;deviceInfo.ppEnabledExtensionNames=deviceExtensions;
    VkDevice device;success(INSTANCE(vkCreateDevice)(physical,&deviceInfo,nullptr,&device),"vkCreateDevice");auto gdpa=(PFN_vkGetDeviceProcAddr)get(instance,"vkGetDeviceProcAddr");if(getenv("VULKAN_TEST_DIRECT_COMMANDS"))gdpa=(PFN_vkGetDeviceProcAddr)dlsym(dlopen(getenv("KL_MVK_DYLIB"),RTLD_NOW|RTLD_LOCAL),"vkGetDeviceProcAddr");
    #define DEVICE(name) ((PFN_##name)gdpa(device,#name))
    VkQueue queue;DEVICE(vkGetDeviceQueue)(device,family,0,&queue);
    VkCommandPoolCreateInfo poolInfo{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};poolInfo.queueFamilyIndex=family;VkCommandPool pool;success(DEVICE(vkCreateCommandPool)(device,&poolInfo,nullptr,&pool),"vkCreateCommandPool");
    for(unsigned phase=0;phase<2;phase++){
        auto carrier=(__bridge CAMetalLayer*)state.carrier;
        carrier.bounds=CGRectMake(0,0,phase?32:64,phase?24:48);carrier.drawableSize=carrier.bounds.size;
        VkSurfaceCapabilitiesKHR capabilities;success(INSTANCE(vkGetPhysicalDeviceSurfaceCapabilitiesKHR)(physical,surface,&capabilities),"vkGetPhysicalDeviceSurfaceCapabilitiesKHR");
        success(INSTANCE(vkGetPhysicalDeviceSurfaceFormatsKHR)(physical,surface,&count,nullptr),"vkGetPhysicalDeviceSurfaceFormatsKHR");std::vector<VkSurfaceFormatKHR> formats(count);success(INSTANCE(vkGetPhysicalDeviceSurfaceFormatsKHR)(physical,surface,&count,formats.data()),"vkGetPhysicalDeviceSurfaceFormatsKHR");
        VkSurfaceFormatKHR format=formats[0];for(auto candidate:formats)if(candidate.format==VK_FORMAT_B8G8R8A8_UNORM)format=candidate;check(format.format==VK_FORMAT_B8G8R8A8_UNORM,"No linear BGRA surface");
        VkSwapchainCreateInfoKHR swapInfo{VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR};swapInfo.surface=surface;swapInfo.minImageCount=capabilities.minImageCount;swapInfo.imageFormat=format.format;swapInfo.imageColorSpace=format.colorSpace;swapInfo.imageExtent=capabilities.currentExtent;swapInfo.imageArrayLayers=1;swapInfo.imageUsage=VK_IMAGE_USAGE_TRANSFER_DST_BIT|VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;swapInfo.preTransform=capabilities.currentTransform;swapInfo.compositeAlpha=VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;swapInfo.presentMode=VK_PRESENT_MODE_FIFO_KHR;swapInfo.clipped=VK_TRUE;
        if(swapInfo.imageExtent.width==UINT32_MAX)swapInfo.imageExtent={phase?32u:64u,phase?24u:48u};
        check(swapInfo.imageExtent.width==(phase?32u:64u)&&swapInfo.imageExtent.height==(phase?24u:48u),"Driver surface extent ignored native window resize");
        VkSwapchainKHR swapchain;success(DEVICE(vkCreateSwapchainKHR)(device,&swapInfo,nullptr,&swapchain),"vkCreateSwapchainKHR");
        success(DEVICE(vkGetSwapchainImagesKHR)(device,swapchain,&count,nullptr),"vkGetSwapchainImagesKHR");std::vector<VkImage> images(count);success(DEVICE(vkGetSwapchainImagesKHR)(device,swapchain,&count,images.data()),"vkGetSwapchainImagesKHR");
        VkFenceCreateInfo fenceInfo{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};VkFence fence;success(DEVICE(vkCreateFence)(device,&fenceInfo,nullptr,&fence),"vkCreateFence");uint32_t index;success(DEVICE(vkAcquireNextImageKHR)(device,swapchain,UINT64_MAX,VK_NULL_HANDLE,fence,&index),"vkAcquireNextImageKHR");success(DEVICE(vkWaitForFences)(device,1,&fence,VK_TRUE,UINT64_MAX),"vkWaitForFences");
        VkCommandBufferAllocateInfo allocation{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};allocation.commandPool=pool;allocation.level=VK_COMMAND_BUFFER_LEVEL_PRIMARY;allocation.commandBufferCount=1;VkCommandBuffer commands;success(DEVICE(vkAllocateCommandBuffers)(device,&allocation,&commands),"vkAllocateCommandBuffers");
        VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};success(DEVICE(vkBeginCommandBuffer)(commands,&begin),"vkBeginCommandBuffer");
        VkImageMemoryBarrier barrier{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};barrier.image=images[index];barrier.srcQueueFamilyIndex=barrier.dstQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED;barrier.subresourceRange={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1};barrier.oldLayout=VK_IMAGE_LAYOUT_UNDEFINED;barrier.newLayout=VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;barrier.dstAccessMask=VK_ACCESS_TRANSFER_WRITE_BIT;
        DEVICE(vkCmdPipelineBarrier)(commands,VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,VK_PIPELINE_STAGE_TRANSFER_BIT,0,0,nullptr,0,nullptr,1,&barrier);VkClearColorValue color{{.2f,.4f,.6f,1}};DEVICE(vkCmdClearColorImage)(commands,images[index],VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,&color,1,&barrier.subresourceRange);
        barrier.oldLayout=barrier.newLayout;barrier.newLayout=VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;barrier.srcAccessMask=VK_ACCESS_TRANSFER_WRITE_BIT;barrier.dstAccessMask=0;DEVICE(vkCmdPipelineBarrier)(commands,VK_PIPELINE_STAGE_TRANSFER_BIT,VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT,0,0,nullptr,0,nullptr,1,&barrier);success(DEVICE(vkEndCommandBuffer)(commands),"vkEndCommandBuffer");
        VkSemaphoreCreateInfo semaphoreInfo{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};VkSemaphore complete;success(DEVICE(vkCreateSemaphore)(device,&semaphoreInfo,nullptr,&complete),"vkCreateSemaphore");VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};submit.commandBufferCount=1;submit.pCommandBuffers=&commands;submit.signalSemaphoreCount=1;submit.pSignalSemaphores=&complete;success(DEVICE(vkQueueSubmit)(queue,1,&submit,VK_NULL_HANDLE),"vkQueueSubmit");
        VkPresentInfoKHR present{VK_STRUCTURE_TYPE_PRESENT_INFO_KHR};present.waitSemaphoreCount=1;present.pWaitSemaphores=&complete;present.swapchainCount=1;present.pSwapchains=&swapchain;present.pImageIndices=&index;success(DEVICE(vkQueuePresentKHR)(queue,&present),"vkQueuePresentKHR");
        success(DEVICE(vkDeviceWaitIdle)(device),"vkDeviceWaitIdle");if(getenv("VULKAN_TEST_RAW_WSI"))state.complete=phase+1;for(unsigned retry=0;state.complete<=phase&&retry<500;retry++)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.01,false);check(state.complete>phase,"Vulkan frame never reached common presenter");
        auto image=getenv("VULKAN_TEST_RAW_WSI")?((__bridge VulkanOutput*)state.carrier).captured.texture:output.captured.texture;check(image!=nil,"No native image");auto readback=[image.device newBufferWithLength:512 options:MTLResourceStorageModeShared];auto q=[image.device newCommandQueue];auto cb=[q commandBuffer];auto copy=[cb blitCommandEncoder];[copy copyFromTexture:image sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(image.width/2,image.height/2,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:readback destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:256];[copy copyFromTexture:(getenv("VULKAN_TEST_RAW_WSI")?image:state.presenter->source) sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:readback destinationOffset:256 destinationBytesPerRow:256 destinationBytesPerImage:256];[copy endEncoding];[cb commit];[cb waitUntilCompleted];check(cb.status==MTLCommandBufferStatusCompleted,"Output readback failed");auto bytes=(unsigned char*)readback.contents;auto original=getenv("VULKAN_TEST_RAW_WSI")?bytes:(unsigned char*)state.producerPixels.contents;fprintf(stderr,"Vulkan pixels phase=%u source=%u,%u,%u,%u output=%u,%u,%u,%u\n",phase,original[0],original[1],original[2],original[3],bytes[0],bytes[1],bytes[2],bytes[3]);fprintf(stderr,"late producer %u,%u,%u,%u\n",bytes[256],bytes[257],bytes[258],bytes[259]);check(abs(int(bytes[0])-153)<=2&&abs(int(bytes[1])-102)<=2&&abs(int(bytes[2])-51)<=2,"Vulkan output pixels differ");
        if(!getenv("VULKAN_TEST_RAW_WSI")){check(image.width==64&&image.height==48,"Source resize changed the display extent");check(state.presenter->source.width==swapInfo.imageExtent.width&&state.presenter->source.height==swapInfo.imageExtent.height,"Presenter source extent differs from the driver");}
        DEVICE(vkDestroySemaphore)(device,complete,nullptr);DEVICE(vkDestroyFence)(device,fence,nullptr);DEVICE(vkFreeCommandBuffers)(device,pool,1,&commands);DEVICE(vkDestroySwapchainKHR)(device,swapchain,nullptr);output.captured=nil;
    }
    DEVICE(vkDestroyCommandPool)(device,pool,nullptr);DEVICE(vkDestroyDevice)(device,nullptr);INSTANCE(vkDestroySurfaceKHR)(instance,surface,nullptr);check(!state.carrier,"Surface retained the native carrier");klj_metal_destroy(state.presenter);INSTANCE(vkDestroyInstance)(instance,nullptr);
}catch(const std::exception &error){fail(env,error.what());}}}
