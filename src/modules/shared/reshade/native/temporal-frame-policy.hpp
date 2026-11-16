#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <algorithm>
#include <cstdio>
#include <string>
#if __has_include("temporal-frame.h")
#include "temporal-frame.h"
#else
#include "../temporal/frame.h"
#endif
namespace macfx {
// OUTPUT_MOTION names the output pixel domain. Its texture view excludes any
// padding in the output allocation; a smaller declared output ROI stays smaller.
inline void temporalOutputMotionView(RSTemporalFrame&frame,unsigned width,unsigned height){
 if(!(frame.flags&RS_TEMPORAL_OUTPUT_MOTION)||!width||!height||frame.motionX>=width||frame.motionY>=height)return;
 frame.outputWidth=std::min(frame.outputWidth,width-frame.motionX);frame.outputHeight=std::min(frame.outputHeight,height-frame.motionY);
}
inline std::string sceneRejectionReason(const std::string&reason,const std::string&rejection){return !rejection.empty()&&reason.rfind("Needs matching renderer",0)==0?rejection:reason;}
template<class Selected,class Default,class Report>
int temporalFrameWithFallback(const RSTemporalFrame*f,const RSImageColorDescription*color,RSTemporalResult*r,bool originalRetained,Selected selected,Default fallback,Report report){
 const int status=selected(f,color,r,originalRetained);
 // An NGX or native MetalFX producer can select another provider through an
 // ordered row; its incoming method still names MetalFX while that row
 // prepares or declines. The ordinary scene is encoded until the row can
 // replace it.
 if(!f||f->size<sizeof(*f)||f->version!=1||!f->owner||!r||r->size<sizeof(*r)||r->version!=1||originalRetained||f->method<RS_TEMPORAL_METALFX||f->method>RS_TEMPORAL_METALFX_DENOISED||(status==RS_TEMPORAL_OK&&r->status==RS_TEMPORAL_OK&&r->encoded))return status;
 auto failed=*r;failed.reason[sizeof(failed.reason)-1]=0;auto actual=*f;actual.method=RS_TEMPORAL_METALFX;actual.reserved=0;
 const int returned=fallback(&actual,color,r);const int code=returned==RS_TEMPORAL_OK&&(r->status!=RS_TEMPORAL_OK||!r->encoded)?(r->status==RS_TEMPORAL_OK?RS_TEMPORAL_FAILED:int(r->status)):returned;if(code!=RS_TEMPORAL_OK){r->status=code;r->encoded=0;}char fallbackReason[sizeof(r->reason)];std::snprintf(fallbackReason,sizeof(fallbackReason),"%s",r->reason);
 if(code==RS_TEMPORAL_OK&&r->encoded)std::snprintf(r->reason,sizeof(r->reason),"Temporal method %u returned %d: %.144s; %s fallback active",f->method,status,failed.reason,r->method==RS_TEMPORAL_OFF?"Real scene image":"MetalFX");
 else std::snprintf(r->reason,sizeof(r->reason),"Temporal method %u returned %d: %.88s; MetalFX fallback failed: %.88s",f->method,status,failed.reason,fallbackReason);
 report(*f,failed,*r,code);return code;
}

}
