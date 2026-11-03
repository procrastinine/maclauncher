#pragma once
#include <sys/types.h>
#include <algorithm>
#include <cstddef>
#include <unordered_set>
#include <vector>

namespace macfx::wcap {
// Keep each app's frontmost window before filling the remaining slots. Input
// and output retain front-to-back app/window order, including off-screen rows.
inline std::vector<size_t> catalogKeep(const std::vector<pid_t> &owners,size_t limit){
    limit=std::min(limit,owners.size());
    std::vector<bool> kept(owners.size());std::unordered_set<pid_t> apps;
    size_t count=0;
    for(size_t i=0;i<owners.size()&&count<limit;++i)
        if(apps.insert(owners[i]).second){kept[i]=true;++count;}
    for(size_t i=0;i<owners.size()&&count<limit;++i)
        if(!kept[i]){kept[i]=true;++count;}
    std::vector<size_t> indices;indices.reserve(limit);
    for(size_t i=0;i<kept.size();++i)if(kept[i])indices.push_back(i);
    return indices;
}
}

#ifdef __OBJC__
#import <Foundation/Foundation.h>
// Sorted metadata rows are partitioned into visible and search-only windows.
// Only visible window IDs enter the thumbnail capture schedule.
NSDictionary *rsCatalogModel(NSArray<NSDictionary*> *displays,NSArray<NSDictionary*> *windows,
    size_t limit,NSSet<NSNumber*> *__autoreleasing *thumbnailWindows);
// Main queue hooks, called only in the capture service. A replacement sends
// catalogStopped to the previous client; stop waits for outstanding requests.
void rsCatalogServe(NSDictionary *request, void (^emit)(NSDictionary *event));
void rsCatalogStopServing(void (^done)(void));
#endif
