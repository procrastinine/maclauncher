#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#include "image-budget.hpp"
#include <chrono>
#include <cstddef>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
namespace macfx {
// A condition that clears when other work completes: a full image budget,
// queue or slot set. Preparation retries it with backoff and the frame path
// holds; a structurally impossible request never fits and is a failure.
struct TransientBusy:std::runtime_error{bool structurallyImpossible=false;explicit TransientBusy(const std::string &reason,bool impossible=false):std::runtime_error(reason.empty()?"Graphics resources are busy":reason),structurallyImpossible(impossible){}};
struct ImageBudgetExceeded:TransientBusy{using TransientBusy::TransientBusy;};
// Retry pacing for one transient condition. Two seconds and three attempts
// indicate sustained pressure, not invalid resources or a failed graph.
// Callers can lengthen backoff while preserving valid work. Not synchronized.
struct TransientBound{
    std::chrono::steady_clock::time_point since{};unsigned attempts=0;
    void reset()noexcept{attempts=0;}
    bool exhausted()const noexcept{return attempts>=3&&std::chrono::steady_clock::now()-since>=std::chrono::seconds(2);}
    // Records one transient attempt and reports whether the bound is reached.
    bool record()noexcept{if(!attempts++)since=std::chrono::steady_clock::now();return exhausted();}
};
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
// Retriable denials (ledger or allocation) raised on the calling thread. Work
// that compares the count around its own allocations knows that device image
// memory, rather than another busy resource, refused it.
uint64_t threadImageDenials()noexcept;
// Device resource pool. Images and buffers are keyed by their descriptor
// (dimensions, type, format, mip and array counts, usage, storage and hazard
// tracking; length and options for buffers) and a role, and each is charged to
// the image budget once however many holders use it. Under budget pressure the
// idle resources of other keys are released before a request is refused.
// A hold on one pooled resource. Copies share the hold; the resource returns to
// the pool when the last copy is dropped, so an in-flight command buffer keeps
// it by capturing a copy (or the object that owns one) in its completion handler.
class PreparedImageLease;
class PooledImage {
public:
    struct Hold;struct Lease;
    PooledImage()=default;explicit PooledImage(std::shared_ptr<Hold>)noexcept;
    PooledImage(const PooledImage&)noexcept;PooledImage(PooledImage&&)noexcept;
    PooledImage&operator=(const PooledImage&)noexcept;PooledImage&operator=(PooledImage&&)noexcept;
    ~PooledImage();
    id<MTLTexture> texture()const noexcept;
    id<MTLBuffer> buffer()const noexcept;
    explicit operator bool()const noexcept{return bool(hold);}
    void reset()noexcept;
private:
    std::shared_ptr<Hold>hold;std::shared_ptr<Lease>lease;
    PooledImage(std::shared_ptr<Hold>,std::shared_ptr<Lease>)noexcept;
    friend class PreparedImageLease;friend class ImagePoolClient;
};
// Shared working resources carry no content from one command buffer to the
// next: every holder of a key (descriptor, role and queue) uses the same
// resource concurrently, writes it before reading it in each command buffer and
// encodes only on that queue, so tracked hazards order the holders' commands.
// A retained chain and a candidate with the same descriptors therefore share
// one copy. The resource is released when its last holder is dropped. Lookup
// happens when resources are prepared, never per frame. Throws
// ImageBudgetExceeded when the budget cannot admit a new resource.
PooledImage shareWorkingImage(id<MTLDevice>,MTLTextureDescriptor*,std::string_view role,id<MTLCommandQueue>,uintptr_t context=0);
PooledImage shareWorkingBuffer(id<MTLDevice>,NSUInteger length,MTLResourceOptions,std::string_view role,id<MTLCommandQueue>,uintptr_t context=0);
// An immutable descriptor binding with a prepared free list. prepare() runs on
// the resource worker and ensures one idle image, growing by one only when all
// prepared images are held. acquire() is allocation-free and never looks up a
// descriptor: an empty result asks the existing preparation worker to warm it.
// Copies held by command completion return the slot after their last release.
class PreparedImageLease {
public:
    struct State;
    PreparedImageLease()=default;
    explicit operator bool()const noexcept{return bool(state);}
    bool prepare()const;
    PooledImage acquire()const;
private:
    std::shared_ptr<State>state;uintptr_t context=0;
    explicit PreparedImageLease(std::shared_ptr<State>value,uintptr_t owner):state(std::move(value)),context(owner){}
    friend class ImagePoolClient;
};
// Exclusive leases (frame-slot scratch). Each client records its latest
// descriptor per role. lease() returns an idle image of the key, or allocates
// one while the key has fewer than `limit` images, or returns an empty hold when
// all of them are held. An idle image is released once no live client's latest
// descriptor for any role matches it: after a resize, a format change or the
// last client's destruction.
class ImagePoolClient {
public:
    struct Pool;
    explicit ImagePoolClient(id<MTLDevice>);
    ~ImagePoolClient();ImagePoolClient(const ImagePoolClient&)=delete;ImagePoolClient&operator=(const ImagePoolClient&)=delete;
    PooledImage lease(MTLTextureDescriptor*,std::string_view role,size_t limit=SIZE_MAX,uintptr_t context=0);
    PreparedImageLease prepare(MTLTextureDescriptor*,std::string_view role,size_t limit=SIZE_MAX,uintptr_t context=0);
private:
    std::shared_ptr<Pool>pool;
};
struct ImagePoolUsage {uint64_t resources=0,held=0,idle=0,bytes=0,idleBytes=0;};
ImagePoolUsage imagePoolUsage(id<MTLDevice>);
}
