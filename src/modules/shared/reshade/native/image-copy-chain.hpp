#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <cstdint>
#include <map>
#include <memory>
#include <utility>
namespace macfx {
// Identities come from observed Metal objects. A relationship is installed
// only by an actual image/view/copy operation, never by matching dimensions.
class ImageCopyChain {
public:
 using Key=uintptr_t;
 struct Context {Key recording=0,device=0,queue=0;bool operator==(const Context&b)const{return recording==b.recording&&device==b.device&&queue==b.queue;}};
 struct Image {Key key=0,device=0;uint64_t format=0;unsigned width=0,height=0;};
 struct Origin {uint64_t producer=0;unsigned role=0;explicit operator bool()const{return producer!=0;}bool operator==(const Origin&b)const{return producer==b.producer&&role==b.role;}};
 struct Region {uint64_t sourceX=0,sourceY=0,sourceZ=0,targetX=0,targetY=0,targetZ=0,width=0,height=0,depth=1,sourceSlice=0,sourceLevel=0,targetSlice=0,targetLevel=0;};
private:
 // A content identity is immutable. Full copies share it, whereas a write
 // replaces only the destination storage's identity. Producer metadata may
 // annotate a previously observed version, but conflicting annotations leave
 // that version unusable everywhere it was copied.
 struct Content {const uint64_t identity;Origin origin;bool conflicted=false,shown=false;Content(uint64_t id,Origin value):identity(id),origin(value){}};
 struct Storage {std::shared_ptr<Content>content;Origin declaration;bool touched=false;};
 struct Node {Image image;Key storage=0;};
 struct Root {Key storage=0;std::weak_ptr<Content>content;};
 Context context;std::map<Key,Node>nodes;std::map<Key,Storage>storage;std::map<std::pair<uint64_t,unsigned>,Root>roots;uint64_t version=0;bool blocked=false;
 std::shared_ptr<Content>fresh(Origin origin){return std::make_shared<Content>(++version,origin);}
 static void conflict(const std::shared_ptr<Content>&value){if(value){value->origin={};value->conflicted=true;}}
 Content*content(Key image)const noexcept{auto node=nodes.find(image);if(blocked||node==nodes.end())return nullptr;auto value=storage.find(node->second.storage);return value==storage.end()||value->second.content->conflicted?nullptr:value->second.content.get();}
public:
 explicit ImageCopyChain(Context actual):context(actual){blocked=!actual.recording||!actual.device||!actual.queue;}
 void invalidate()noexcept{blocked=true;}
 bool add(Image image){
  if(blocked||!image.key||image.device!=context.device||!image.width||!image.height||!image.format)return false;
  auto old=nodes.find(image.key);if(old!=nodes.end())return old->second.image.device==image.device&&old->second.image.format==image.format&&old->second.image.width==image.width&&old->second.image.height==image.height;
  if(nodes.size()>=256){invalidate();return false;}
  nodes.emplace(image.key,Node{image,image.key});storage.emplace(image.key,Storage{fresh(Origin{}),{},false});return true;
 }
 bool view(Image image,Key parent,bool complete){
  auto base=nodes.find(parent);if(!complete||base==nodes.end()||!add(image)||image.width!=base->second.image.width||image.height!=base->second.image.height)return false;
  auto&node=nodes.at(image.key);const auto physical=base->second.storage;
  if(node.storage==physical)return true;
  // Learning an alias cannot erase already observed writes/copies on an
  // independently tracked allocation or move an existing view elsewhere.
  if(node.storage!=image.key||storage.at(node.storage).touched)return false;
  node.storage=physical;return true;
 }
 void write(Key image){auto node=nodes.find(image);if(blocked||node==nodes.end())return;auto&value=storage.at(node->second.storage);value={fresh(Origin{}),{},true};}
 bool producer(Key image,Origin origin){
  auto node=nodes.find(image);if(blocked||node==nodes.end()||!origin||(origin.role!=1&&origin.role!=2))return false;
  auto&value=storage.at(node->second.storage);const auto rootKey=std::make_pair(origin.producer,origin.role);auto prior=roots.find(rootKey);
  if(prior!=roots.end()){
   const auto previous=prior->second.content.lock();
   if(previous&&previous==value.content&&!previous->conflicted&&(origin.role==1||prior->second.storage==node->second.storage)&&previous->origin==origin){value.declaration=origin;value.touched=true;return true;}
   conflict(previous);conflict(value.content);return false;
  }
  if(roots.size()>=256){for(auto it=roots.begin();it!=roots.end();)if(it->second.content.expired())it=roots.erase(it);else ++it;}
  if(roots.size()>=256){invalidate();return false;}
  if(origin.role==1){
   // The SDK reads the already existing current-image version. Its earlier
   // exact copies therefore receive this annotation too.
   if(value.content->conflicted||(value.content->origin&&!(value.content->origin==origin))){conflict(value.content);return false;}
   value.content->origin=origin;
  }else{
   // The SDK writes a new output version. An aliased current/output pair
   // cannot be admitted as two independent endpoints of one interval.
   if(value.declaration.producer==origin.producer&&value.declaration.role!=origin.role){conflict(value.content);return false;}
   value.content=fresh(origin);
  }
  value.declaration=origin;value.touched=true;roots.emplace(rootKey,Root{node->second.storage,value.content});return true;
 }
 Origin origin(Key image)const{
  auto node=nodes.find(image);if(blocked||node==nodes.end())return {};const auto value=storage.find(node->second.storage);if(value==storage.end()||value->second.content->conflicted)return {};return value->second.content->origin;
 }
 bool copy(Context actual,Key source,Key target,const Region&r){
  auto a=nodes.find(source),b=nodes.find(target);std::shared_ptr<Content>from;
  if(a!=nodes.end())from=storage.at(a->second.storage).content;
  write(target);
  if(blocked||!(actual==context)||a==nodes.end()||b==nodes.end()||a->second.storage==b->second.storage||!from||from->conflicted)return false;
  const auto&x=a->second.image;const auto&y=b->second.image;
  if(x.device!=y.device||x.format!=y.format||x.width!=y.width||x.height!=y.height||r.sourceX||r.sourceY||r.sourceZ||r.targetX||r.targetY||r.targetZ||r.sourceSlice||r.sourceLevel||r.targetSlice||r.targetLevel||r.depth!=1||r.width!=x.width||r.height!=x.height)return false;
  // Unknown content is still an exact version: a later SDK current-image
  // annotation may identify it, including copies made before the SDK call.
  auto&to=storage.at(b->second.storage);to.content=from;to.declaration={};to.touched=true;return true;
 }
 // Presentation follows a content version through its exact copies/views.
 // A later write or SDK output starts a distinct, unpresented version.
 uint64_t contentVersion(Key image)const noexcept{auto value=content(image);return value?value->identity:0;}
 void presented(Key image)noexcept{if(auto value=content(image))value->shown=true;}
 bool wasPresented(Key image)const noexcept{auto value=content(image);return value&&value->shown;}
 void presentedVersion(uint64_t identity)noexcept{if(blocked||!identity)return;for(auto&entry:storage)if(entry.second.content->identity==identity)entry.second.content->shown=true;}
 bool valid()const{return !blocked;}
};
// Actual enqueue calls assign these ordinals while holding their queue lock.
// Encoding order alone cannot authorize replay past an uncommitted buffer.
class ImageCopyQueueOrder {
 struct Entry {uintptr_t recording=0;bool ready=false;};
 uint64_t next=0,cursor=1;std::map<uint64_t,Entry>pending;
public:
 uint64_t reserve(uintptr_t recording){if(!recording||pending.size()>=256)return 0;const auto ordinal=++next;pending.emplace(ordinal,Entry{recording,false});return ordinal;}
 bool ready(uint64_t ordinal){auto found=pending.find(ordinal);if(found==pending.end())return false;found->second.ready=true;return true;}
 std::pair<uint64_t,uintptr_t>take(uint64_t limit){auto found=pending.find(cursor);if(found==pending.end()||!found->second.ready||cursor>limit)return {};auto result=std::make_pair(cursor,found->second.recording);pending.erase(found);++cursor;return result;}
 static bool consumes(uint64_t producer,uint64_t consumer,bool submitted,bool sameRecording)noexcept{return producer&&consumer&&((sameRecording&&producer==consumer)||(submitted&&producer<consumer));}
};

}
