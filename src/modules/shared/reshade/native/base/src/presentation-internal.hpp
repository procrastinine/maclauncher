#pragma once
#import <Foundation/Foundation.h>

#import <objc/runtime.h>
namespace macfx {
inline char ownedPresentationKey,ownedPresentationBufferKey;
inline bool ownsPresentation(id layer){return objc_getAssociatedObject(layer,&ownedPresentationKey)!=nil;}
inline void ownPresentation(id layer){objc_setAssociatedObject(layer,&ownedPresentationKey,@YES,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
inline bool ownsPresentationBuffer(id buffer){return objc_getAssociatedObject(buffer,&ownedPresentationBufferKey)!=nil;}
inline void ownPresentationBuffer(id buffer){objc_setAssociatedObject(buffer,&ownedPresentationBufferKey,@YES,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
}
