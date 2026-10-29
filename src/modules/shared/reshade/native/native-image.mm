// Copyright (c) MacLauncher contributors. MIT license.
#include "native-image.hpp"
#include "local-laplacian.hpp"
#include "cmaa2.hpp"
#include "xegtao.hpp"
#include "cacao.hpp"
#include "depth-effects.hpp"
#include "estimated-depth-fog.hpp"
#include "dof.hpp"
#include "ssr.hpp"
#include "histogram-exposure.hpp"
#include "ffx-lens.hpp"
#include "ffx-blur.hpp"
#import <Foundation/Foundation.h>
#include <cmath>
#include <filesystem>
#include <stdexcept>
namespace macfx {namespace {
struct Declaration {std::string method;ShaderParameters parameters;};
Declaration declaration(const ShaderSpec&spec){@autoreleasepool{
 const auto path=std::filesystem::path(spec.selection.file);if(!path.is_absolute()||path.extension()!=".mclfilter")throw std::runtime_error("Choose a prepared native image-effect descriptor");
 if(!std::filesystem::is_regular_file(path)||std::filesystem::file_size(path)>65536)throw std::runtime_error("The image-effect descriptor must be a file of at most 64 KiB");
 NSError*error=nil;auto bytes=[NSData dataWithContentsOfFile:@(spec.selection.file.c_str()) options:NSDataReadingMappedIfSafe error:&error];if(!bytes||bytes.length>65536)throw std::runtime_error("The image-effect descriptor must be readable and at most 64 KiB");
 id value=[NSJSONSerialization JSONObjectWithData:bytes options:0 error:&error];if(![value isKindOfClass:NSDictionary.class])throw std::runtime_error("The image-effect descriptor is invalid");NSDictionary*root=value;
 for(id key in root)if(![@[@"schema",@"method",@"parameters"] containsObject:key])throw std::runtime_error("The image-effect descriptor contains an unsupported field");
 const auto number=[](id value){return [value isKindOfClass:NSNumber.class]&&CFGetTypeID((__bridge CFTypeRef)value)!=CFBooleanGetTypeID()&&std::isfinite([value doubleValue]);};
 if(!number(root[@"schema"])||[root[@"schema"] doubleValue]!=1||![root[@"method"] isKindOfClass:NSString.class])throw std::runtime_error("The image-effect descriptor version or method is invalid");
 Declaration result;result.method=[root[@"method"] UTF8String];if(result.method!="screen-space-reflections"&&result.method!="histogram-exposure"&&result.method!="local-laplacian"&&result.method!="cmaa2"&&result.method!="xegtao"&&result.method!="cacao"&&result.method!="depth-fog"&&result.method!="depth-outlines"&&result.method!="estimated-depth-fog"&&result.method!="ffx-dof"&&result.method!="ffx-lens"&&result.method!="ffx-blur")throw std::runtime_error("The compiled image-effect method is unavailable");
 id parameters=root[@"parameters"]?:@{};if(![parameters isKindOfClass:NSDictionary.class]||[parameters count]>16)throw std::runtime_error("The image-effect descriptor parameters are invalid");
 for(id key in parameters){id value=parameters[key];if(![key isKindOfClass:NSString.class]||!number(value)||!std::isfinite(float([value doubleValue])))throw std::runtime_error("Image-effect defaults must be finite scalar values");result.parameters[[key UTF8String]]={float([value doubleValue])};}
 for(const auto&[key,values]:spec.parameters){if(values.size()!=1||!std::isfinite(values[0]))throw std::runtime_error("Image-effect controls require finite scalar values");result.parameters[key]=values;}
 return result;
}}
}
bool nativeImageUsesSDR(const ShaderSpec&spec){return declaration(spec).method=="local-laplacian";}
std::shared_ptr<ShaderNode>makeNativeImageShaderNode(const ShaderSpec&spec,const std::string&modelPath,const std::string&modelOperation){const auto value=declaration(spec);if(value.method=="estimated-depth-fog"){if(modelOperation!="depth-anything-v2-small")throw std::runtime_error("Choose a compatible relative-depth model");return makeEstimatedDepthFogNode(value.parameters,modelPath);}if(!modelPath.empty()||!modelOperation.empty())throw std::runtime_error("This image effect does not consume a model");if(value.method=="ffx-lens")return makeFfxLensNode(value.parameters);if(value.method=="ffx-blur")return makeFfxBlurNode(value.parameters);if(value.method=="screen-space-reflections")return makeScreenSpaceReflectionsNode(value.parameters);if(value.method=="histogram-exposure")return makeHistogramExposureNode(value.parameters);if(value.method=="ffx-dof")return makeFfxDofNode(value.parameters);if(value.method=="local-laplacian")return makeLocalLaplacianNode(value.parameters);if(value.method=="cmaa2")return makeCmaa2Node(value.parameters);if(value.method=="xegtao")return makeXegtaoNode(value.parameters);if(value.method=="depth-fog")return makeDepthFogNode(value.parameters);if(value.method=="depth-outlines")return makeDepthOutlinesNode(value.parameters);return makeCacaoNode(value.parameters);}
std::shared_ptr<ShaderNode>forkNativeImageShaderNode(const std::shared_ptr<ShaderNode>&previous,const ShaderSpec&spec,const std::string&modelPath,const std::string&modelOperation){const auto value=declaration(spec);if(value.method=="estimated-depth-fog"){if(modelOperation!="depth-anything-v2-small")throw std::runtime_error("Choose a compatible relative-depth model");return forkEstimatedDepthFogNode(previous,value.parameters,modelPath);}if(!modelPath.empty()||!modelOperation.empty())throw std::runtime_error("This image effect does not consume a model");if(value.method=="ffx-lens")return forkFfxLensNode(previous,value.parameters);if(value.method=="ffx-blur")return forkFfxBlurNode(previous,value.parameters);if(value.method=="screen-space-reflections")return forkScreenSpaceReflectionsNode(previous,value.parameters);if(value.method=="histogram-exposure")return forkHistogramExposureNode(previous,value.parameters);if(value.method=="ffx-dof")return forkFfxDofNode(previous,value.parameters);if(value.method=="local-laplacian")return forkLocalLaplacianNode(previous,value.parameters);if(value.method=="cmaa2")return forkCmaa2Node(previous,value.parameters);if(value.method=="xegtao")return forkXegtaoNode(previous,value.parameters);if(value.method=="depth-fog")return forkDepthFogNode(previous,value.parameters);if(value.method=="depth-outlines")return forkDepthOutlinesNode(previous,value.parameters);return forkCacaoNode(previous,value.parameters);}
void setNativeImageShaderColor(const std::shared_ptr<ShaderNode>&node,const ImageColorDescription&color){setLocalLaplacianNodeColor(node,color);setCmaa2NodeColor(node,color);setXegtaoNodeColor(node,color);setCacaoNodeColor(node,color);setDepthFogNodeColor(node,color);setDepthOutlinesNodeColor(node,color);setEstimatedDepthFogNodeColor(node,color);setFfxDofNodeColor(node,color);setHistogramExposureNodeColor(node,color);setScreenSpaceReflectionsNodeColor(node,color);setFfxLensNodeColor(node,color);setFfxBlurNodeColor(node,color);}
ShaderResult nativeImagePreparationStatus(const std::shared_ptr<ShaderNode>&node){return estimatedDepthFogPreparationStatus(node);}
bool nativeImageGpuTimingAvailable(const std::shared_ptr<ShaderNode>&node){return estimatedDepthFogGpuTimingAvailable(node);}
ShaderResult encodeNativeImageStamped(const std::shared_ptr<ShaderNode>&node,const ShaderFrame&frame,const NeuralInputStamp&stamp,bool redraw,bool displayMapped,std::function<ShaderResult()>*completion,NeuralGpuTimingTicket*timing){auto result=isHistogramExposureNode(node)?encodeHistogramExposureStamped(node,frame,stamp,redraw,displayMapped,completion):encodeEstimatedDepthFogStamped(node,frame,stamp,redraw,displayMapped,completion,timing);if(result.encoded&&completion&&!*completion){*completion=ffxLensCompletionTicket(node);if(!*completion)*completion=ffxBlurCompletionTicket(node);}return result;}
ShaderResult finishNativeImageNode(const std::shared_ptr<ShaderNode>&node){auto result=finishEstimatedDepthFogNode(node);if(!result.encoded)return result;result=finishFfxDofNode(node);if(!result.encoded)return result;result=finishScreenSpaceReflectionsNode(node);if(!result.encoded)return result;result=finishHistogramExposureNode(node);if(!result.encoded)return result;result=finishFfxLensNode(node);return result.encoded?finishFfxBlurNode(node):result;}
}
