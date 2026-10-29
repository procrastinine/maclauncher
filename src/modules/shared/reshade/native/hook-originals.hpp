#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <objc/runtime.h>
#include <cstdint>
#include <map>
#include <mutex>
#include <utility>

namespace macfx {
// Implementations saved by Objective-C method replacement. A receiver searches
// its class chain under the owner lock. A saved pair never changes, so each
// thread also keeps hits found on the searched class itself. Any other class,
// including a later KVO or dynamic subclass, searches again. Owners live for
// the whole process because hooks can run during static destruction.
class HookOriginals {
    struct Lookup {const HookOriginals *owner;Class cls;SEL selector;IMP implementation;};
    struct Install {const HookOriginals *owner;Class cls;SEL selector;};
    static size_t slot(Class cls,SEL selector){const auto c=reinterpret_cast<uintptr_t>(cls),s=reinterpret_cast<uintptr_t>(selector);return ((c>>4)^(c>>11)^(s>>3)^(s>>9))&31;}
    static Lookup *lookups(){thread_local Lookup entries[32]{};return entries;}
    static Install *installs(){thread_local Install entries[32]{};return entries;}
    std::mutex lock;std::map<std::pair<Class,SEL>,IMP> saved;
public:
    struct Found {Class owner=Nil;IMP implementation=nullptr;};
    // The nearest saved implementation at or above cls, with the class that owns it.
    Found find(Class cls,SEL selector){
        if(!cls)return {};
        auto &entry=lookups()[slot(cls,selector)];
        if(entry.owner==this&&entry.cls==cls&&entry.selector==selector)return {cls,entry.implementation};
        std::lock_guard<std::mutex> guard(lock);
        for(Class c=cls;c;c=class_getSuperclass(c))if(const auto found=saved.find({c,selector});found!=saved.end()){
            if(c==cls)entry={this,cls,selector,found->second};
            return {c,found->second};
        }
        return {};
    }
    IMP original(id object,SEL selector){return find(object_getClass(object),selector).implementation;}
    // Saves the current implementation and installs hook on cls once. Later calls
    // for the same class and selector change nothing, even after another library
    // replaced the hook: its wrapper may call the hook as its own original, and
    // saving that wrapper again would make the two call each other. Each thread
    // remembers pairs it has seen saved, since a saved pair is permanent.
    void replace(Class cls,SEL selector,IMP hook){
        if(!cls)return;
        auto &memo=installs()[slot(cls,selector)];
        if(memo.owner==this&&memo.cls==cls&&memo.selector==selector)return;
        std::lock_guard<std::mutex> guard(lock);
        if(!saved.count({cls,selector})){
            const Method method=class_getInstanceMethod(cls,selector);if(!method)return;
            const IMP old=method_getImplementation(method);if(old==hook)return;
            saved[{cls,selector}]=old;
            if(!class_addMethod(cls,selector,hook,method_getTypeEncoding(method)))method_setImplementation(class_getInstanceMethod(cls,selector),hook);
        }
        memo={this,cls,selector};
    }
};
}
