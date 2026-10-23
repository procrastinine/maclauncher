#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#include "image-budget.hpp"
#include <memory>
#include <stdexcept>
#include <string_view>
namespace macfx {
struct ImageBudgetExceeded:std::runtime_error{bool structurallyImpossible=false;explicit ImageBudgetExceeded(const std::string &reason,bool impossible=false):std::runtime_error(reason),structurallyImpossible(impossible){}};
class ImageReservation {
    struct Impl;std::unique_ptr<Impl>impl;
    explicit ImageReservation(std::unique_ptr<Impl>);friend std::shared_ptr<ImageReservation> reserveImageBytes(id<MTLDevice>,uint64_t,uintptr_t,std::string_view,bool);
    friend void retireOwnedSurface(IOSurfaceRef,std::shared_ptr<ImageReservation>);
    friend void pollRetiredImages()noexcept;
public:
    ~ImageReservation();ImageReservation(const ImageReservation&)=delete;ImageReservation&operator=(const ImageReservation&)=delete;
    void commit(uint64_t actualBytes=0);
    uint64_t bytes()const noexcept;
};
std::shared_ptr<ImageReservation> reserveImageBytes(id<MTLDevice>,uint64_t,uintptr_t context=0,std::string_view stage={},bool external=false);
void attachImageReservation(id<MTLTexture>,const std::shared_ptr<ImageReservation>&);
id<MTLTexture> newAdmittedTexture(id<MTLDevice>,MTLTextureDescriptor*,uintptr_t context=0,std::string_view stage={});
// Consumes one owned CF reference; WindowServer can retain the allocation after
// its producing pool has retired. The existing control tick completes cleanup.
void retireOwnedSurface(IOSurfaceRef,std::shared_ptr<ImageReservation>);
void pollRetiredImages()noexcept;
}
