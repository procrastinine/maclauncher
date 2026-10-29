// Copyright (c) MacLauncher contributors. MIT license.
#include "metal4-classic-bridge.hpp"
#include "hook-originals.hpp"
#import <objc/runtime.h>
#import <Metal/MTL4CommandBuffer.h>
#import <Metal/MTL4CommandQueue.h>
#import <Metal/MTL4ComputeCommandEncoder.h>
#include <atomic>
#include <mutex>
#include <map>
#include <algorithm>
#include <vector>
namespace macfx::m4bridge {
struct Record;struct Pool;
struct Slot {id commands=nil,original=nil,allocator=nil,retirement=nil;id<MTLSharedEvent>event=nil;std::atomic<bool>busy{false},failed{false};uint64_t generation=0;};
struct SlotReservation {std::shared_ptr<Slot>slot;bool retained=false,started=false;~SlotReservation(){if(!retained){if(started)slot->failed=true;slot->busy=false;}}};
struct Job {std::shared_ptr<Slot>slot;id<MTLCommandBuffer>commands=nil,publication=nil;std::shared_ptr<Pool>pool;id original=nil;Metal4ClassicJob callbacks;ShaderResult outcome{false,"The shared Metal 4 job has not completed",true};uint64_t ready=0,published=0,originalReady=0,done=0;std::atomic<bool>canceled{false};bool active=true,originalSubmitted=false,originalCompleted=false,publishing=false,lateOriginal=false,finalized=false;std::function<void()>afterOriginal;};
struct QueueOrder {std::recursive_mutex mutex;std::function<void()>flush;const void*pending=nullptr;};
struct Segment {__weak id commands=nil;std::shared_ptr<Job>after;};
struct Pool {id<MTLDevice>device;id<MTLCommandQueue>queue;id nativeProbe=nil;std::mutex mutex,sequencing;std::vector<std::shared_ptr<Slot>>slots;};
struct Record {std::recursive_mutex mutex;__weak id logical,current;id allocator=nil,beginOptions=nil;bool begun=false,ended=false,submitted=false,suspended=false;unsigned encoders=0;NSMutableArray*residency=[NSMutableArray array];NSMutableArray*debug=[NSMutableArray array];std::vector<Segment>segments;std::shared_ptr<Pool>pool;Metal4SubmissionContext submission;~Record(){for(auto&segment:segments)if(segment.after&&!submitted){segment.after->slot->busy=false;if(segment.after->callbacks.originalAbandoned)segment.after->callbacks.originalAbandoned();if(segment.after->callbacks.retired)segment.after->callbacks.retired({false,"The Metal 4 recording was discarded"});}}};
struct EncoderRecord {std::weak_ptr<Record>record;bool suspends=false,render=false;};
static char recordingKey,aliasKey,encoderKey,optionsKey,queueKey;
static std::mutex hooksMutex;
static HookOriginals &originals(){static auto *value=new HookOriginals;return *value;}
static thread_local bool internal=false;
struct Internal {bool previous=internal;Internal(){internal=true;}~Internal(){internal=previous;}};
struct OriginalCall {uintptr_t object;SEL selector;Class owner;};static thread_local std::vector<OriginalCall>originalCalls;
std::pair<Class,IMP>findOriginal(id object,SEL selector){auto cls=object_getClass(object);for(auto call=originalCalls.rbegin();call!=originalCalls.rend();++call)if(call->object==reinterpret_cast<uintptr_t>((__bridge void*)object)&&call->selector==selector){cls=class_getSuperclass(call->owner);break;}const auto found=originals().find(cls,selector);return {found.owner,found.implementation};}
struct OriginalScope {OriginalScope(id object,SEL selector,Class owner){originalCalls.push_back({reinterpret_cast<uintptr_t>((__bridge void*)object),selector,owner});}~OriginalScope(){originalCalls.pop_back();}};
void hook(Class cls,SEL selector,IMP replacement){originals().replace(cls,selector,replacement);}
template<class R,class...A>R invoke(id object,SEL selector,A...arguments){auto found=findOriginal(object,selector);OriginalScope mark(object,selector,found.first);Internal scope;return reinterpret_cast<R(*)(id,SEL,A...)>(found.second)(object,selector,arguments...);}
template<class...A>id invokeRetained(id object,SEL selector,A...arguments){auto found=findOriginal(object,selector);OriginalScope mark(object,selector,found.first);Internal scope;return (__bridge_transfer id)reinterpret_cast<void*(*)(id,SEL,A...)>(found.second)(object,selector,arguments...);}
}
@interface MLMetal4RecordBox:NSObject {@public std::shared_ptr<macfx::m4bridge::Record>value;}@end
@implementation MLMetal4RecordBox @end
@interface MLMetal4AliasBox:NSObject {@public std::weak_ptr<macfx::m4bridge::Record>value;}@end
@implementation MLMetal4AliasBox @end
@interface MLMetal4EncoderBox:NSObject {@public macfx::m4bridge::EncoderRecord value;}@end
@implementation MLMetal4EncoderBox @end
@interface MLMetal4OptionsBox:NSObject
@property(nonatomic,strong)NSMutableArray*handlers;
@end
@implementation MLMetal4OptionsBox @end
@interface MLMetal4QueueBox:NSObject
{@public std::shared_ptr<macfx::m4bridge::QueueOrder>order;}
@property(nonatomic,strong)dispatch_queue_t feedbackQueue;
@end
@implementation MLMetal4QueueBox @end
API_AVAILABLE(macos(26.0))
@interface MLMetal4Feedback:NSObject<MTL4CommitFeedback>
@property(nonatomic,strong)NSError*error;
@property(nonatomic)CFTimeInterval GPUStartTime;
@property(nonatomic)CFTimeInterval GPUEndTime;
@end
@implementation MLMetal4Feedback @end
namespace macfx::m4bridge {
std::shared_ptr<QueueOrder>queueOrder(id queue){@synchronized(queue){auto box=(MLMetal4QueueBox*)objc_getAssociatedObject(queue,&queueKey);if(!box){box=[MLMetal4QueueBox new];box->order=std::make_shared<QueueOrder>();objc_setAssociatedObject(queue,&queueKey,box,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}if(!box->order)box->order=std::make_shared<QueueOrder>();return box->order;}}
void flushQueue(id queue){auto order=queueOrder(queue);std::lock_guard guard(order->mutex);if(order->flush){auto flush=std::move(order->flush);order->pending=nullptr;flush();}}
std::shared_ptr<Record>record(id object){MLMetal4RecordBox*box=objc_getAssociatedObject(object,&recordingKey);if(box)return box->value;MLMetal4AliasBox*alias=objc_getAssociatedObject(object,&aliasKey);return alias?alias->value.lock():nullptr;}
id target(id object){auto value=record(object);if(!value)return object;std::lock_guard guard(value->mutex);return value->current?:object;}
void endEncoder(id self,SEL selector){auto box=(MLMetal4EncoderBox*)objc_getAssociatedObject(self,&encoderKey);objc_setAssociatedObject(self,&encoderKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);invoke<void>(self,selector);if(box)if(auto value=box->value.record.lock()){std::lock_guard guard(value->mutex);if(value->encoders)--value->encoders;if(box->value.render)value->suspended=box->value.suspends;}}
id encoder(id logical,id actual,bool suspends=false,bool render=false){if(!actual)return nil;auto value=record(logical);if(!value){objc_setAssociatedObject(actual,&encoderKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);return actual;}auto box=[MLMetal4EncoderBox new];box->value={value,suspends,render};{std::lock_guard guard(value->mutex);++value->encoders;}objc_setAssociatedObject(actual,&encoderKey,box,OBJC_ASSOCIATION_RETAIN_NONATOMIC);hook(object_getClass(actual),@selector(endEncoding),(IMP)endEncoder);return actual;}
void begin(id self,SEL selector,id allocator){invoke<void>(self,selector,allocator);if(internal)return;auto value=std::make_shared<Record>();value->logical=self;value->current=self;value->allocator=allocator;value->begun=true;auto box=[MLMetal4RecordBox new];box->value=value;objc_setAssociatedObject(self,&recordingKey,box,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
void beginOptions(id self,SEL selector,id allocator,id options){invoke<void>(self,selector,allocator,options);if(internal)return;auto value=std::make_shared<Record>();value->logical=self;value->current=self;value->allocator=allocator;value->beginOptions=[options copy];value->begun=true;auto box=[MLMetal4RecordBox new];box->value=value;objc_setAssociatedObject(self,&recordingKey,box,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
void end(id self,SEL selector){if(internal){invoke<void>(self,selector);return;}auto value=record(self);if(!value){invoke<void>(self,selector);return;}std::lock_guard guard(value->mutex);invoke<void>(value->current,selector);value->ended=true;}
id compute(id self,SEL selector){if(internal)return invoke<id>(self,selector);return encoder(self,invoke<id>(target(self),selector));}
id render(id self,SEL selector,id descriptor){if(internal)return invoke<id>(self,selector,descriptor);return encoder(self,invoke<id>(target(self),selector,descriptor),false,true);}
id renderOptions(id self,SEL selector,id descriptor,NSUInteger options){if(internal)return invoke<id>(self,selector,descriptor,options);if(@available(macOS 26.0,*))return encoder(self,invoke<id>(target(self),selector,descriptor,options),bool(options&MTL4RenderEncoderOptionSuspending),true);return nil;}
void residency(id self,SEL selector,id set){if(!internal)if(auto value=record(self)){std::lock_guard guard(value->mutex);if(![value->residency containsObject:set])[value->residency addObject:set];}invoke<void>(internal?self:target(self),selector,set);}
void residencies(id self,SEL selector,const id*sets,NSUInteger count){if(!internal)if(auto value=record(self)){std::lock_guard guard(value->mutex);for(NSUInteger i=0;i<count;++i)if(![value->residency containsObject:sets[i]])[value->residency addObject:sets[i]];}invoke<void>(internal?self:target(self),selector,sets,count);}
void push(id self,SEL selector,NSString*label){if(!internal)if(auto value=record(self)){std::lock_guard guard(value->mutex);[value->debug addObject:label];}invoke<void>(internal?self:target(self),selector,label);}
void pop(id self,SEL selector){if(!internal)if(auto value=record(self)){std::lock_guard guard(value->mutex);if(value->debug.count)[value->debug removeLastObject];}invoke<void>(internal?self:target(self),selector);}
void setProperty(id self,SEL selector,id value){invoke<void>(internal?self:target(self),selector,value);}
id getProperty(id self,SEL selector){return invoke<id>(internal?self:target(self),selector);}
void timestamp(id self,SEL selector,id heap,NSUInteger index){invoke<void>(internal?self:target(self),selector,heap,index);}
void resolve(id self,SEL selector,id heap,NSRange range,MTL4BufferRange buffer,id wait,id update){invoke<void>(internal?self:target(self),selector,heap,range,buffer,wait,update);}
void installCommands(Class cls){
 hook(cls,@selector(beginCommandBufferWithAllocator:),(IMP)begin);hook(cls,@selector(beginCommandBufferWithAllocator:options:),(IMP)beginOptions);hook(cls,@selector(endCommandBuffer),(IMP)end);
 hook(cls,@selector(computeCommandEncoder),(IMP)compute);hook(cls,@selector(machineLearningCommandEncoder),(IMP)compute);hook(cls,@selector(renderCommandEncoderWithDescriptor:),(IMP)render);hook(cls,@selector(renderCommandEncoderWithDescriptor:options:),(IMP)renderOptions);
 hook(cls,@selector(useResidencySet:),(IMP)residency);hook(cls,@selector(useResidencySets:count:),(IMP)residencies);hook(cls,@selector(pushDebugGroup:),(IMP)push);hook(cls,@selector(popDebugGroup),(IMP)pop);hook(cls,@selector(writeTimestampIntoHeap:atIndex:),(IMP)timestamp);hook(cls,@selector(resolveCounterHeap:withRange:intoBuffer:waitFence:updateFence:),(IMP)resolve);
 hook(cls,@selector(logState),(IMP)getProperty);hook(cls,@selector(setLogState:),(IMP)setProperty);hook(cls,@selector(label),(IMP)getProperty);hook(cls,@selector(setLabel:),(IMP)setProperty);
}
static id newCommands(id self,SEL selector) __attribute__((ns_returns_retained));
static id newCommands(id self,SEL selector){Internal scope;id value=invokeRetained(self,selector);if(value)installCommands(object_getClass(value));return value;}
static std::map<Class,IMP>feedbackWrappers;
void installFeedbackClass(Class cls){std::lock_guard guard(hooksMutex);if(feedbackWrappers.count(cls))return;auto method=class_getInstanceMethod(cls,@selector(addFeedbackHandler:));if(!method)return;auto previous=method_getImplementation(method);for(auto&entry:feedbackWrappers)if(entry.second==previous)return;auto replacement=imp_implementationWithBlock(^(id object,id block){if(!internal)if(auto box=(MLMetal4OptionsBox*)objc_getAssociatedObject(object,&optionsKey))@synchronized(box){[box.handlers addObject:[block copy]];}Internal scope;reinterpret_cast<void(*)(id,SEL,id)>(previous)(object,@selector(addFeedbackHandler:),block);});if(!class_addMethod(cls,@selector(addFeedbackHandler:),replacement,method_getTypeEncoding(method)))method_setImplementation(class_getInstanceMethod(cls,@selector(addFeedbackHandler:)),replacement);feedbackWrappers[cls]=replacement;}
static id allocateOptions(id self,SEL selector,NSZone*zone) __attribute__((ns_returns_retained));
static id allocateOptions(id self,SEL selector,NSZone*zone){id value=invokeRetained(self,selector,zone);if(value){installFeedbackClass(object_getClass(value));auto box=[MLMetal4OptionsBox new];box.handlers=[NSMutableArray array];objc_setAssociatedObject(value,&optionsKey,box,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}return value;}
void feedback(id self,SEL selector,id block){if(auto box=(MLMetal4OptionsBox*)objc_getAssociatedObject(self,&optionsKey))@synchronized(box){[box.handlers addObject:[block copy]];}invoke<void>(self,selector,block);}
void nativeCommit(id queue,const std::vector<id>&commands,id options);
struct Group:std::enable_shared_from_this<Group>{
 std::mutex mutex;unsigned remaining=0;double start=0,finish=0;NSError*error=nil;NSArray*handlers=nil;dispatch_queue_t callbackQueue=nullptr;
 id nativeQueue=nil,feedbackCommands=nil;std::vector<id>buffers;std::vector<std::shared_ptr<Record>>records;
 void deliver(){if(@available(macOS 26.0,*)){
  auto report=[MLMetal4Feedback new];report.GPUStartTime=start;report.GPUEndTime=finish;report.error=error;
  for(auto&record:records){std::lock_guard guard(record->mutex);for(auto&segment:record->segments)if(segment.after){auto&job=segment.after;job->slot->busy=false;if(job->callbacks.retired)job->callbacks.retired(!job->active?ShaderResult{false,"Original Metal 4 output retained: the submission context was unobserved"}:error?ShaderResult{false,error.localizedDescription.UTF8String?:"Metal 4 submission failed"}:job->outcome);}record->segments.clear();record->current=record->logical;record->pool.reset();}
  records.clear();buffers.clear();for(MTL4CommitFeedbackHandler handler in handlers)handler(report);
 }}
 void complete(double first,double last,NSError*failure){if(@available(macOS 26.0,*)){
  bool ready=false;{std::lock_guard guard(mutex);if(first>0)start=start>0?std::min(start,first):first;if(last>0)finish=std::max(finish,last);if(!error&&failure)error=failure;ready=remaining&&!--remaining;}if(!ready)return;
  auto group=shared_from_this();
  if(callbackQueue){dispatch_async(callbackQueue,^{group->deliver();});return;}
  // A nil descriptor queue belongs to Metal. Deliver on a genuine feedback
  // callback from that exact producer queue rather than guessing a GCD queue.
  if(nativeQueue&&feedbackCommands){auto options=[MTL4CommitOptions new];[options addFeedbackHandler:^(id<MTL4CommitFeedback>report){if(report.error&&!group->error)group->error=report.error;group->deliver();}];nativeCommit(nativeQueue,{feedbackCommands},options);return;}
  deliver();
 }}
};
void nativeCommit(id queue,const std::vector<id>&commands,id options){Internal scope;if(options)invoke<void>(queue,@selector(commit:count:options:),commands.data(),NSUInteger(commands.size()),options);else invoke<void>(queue,@selector(commit:count:),commands.data(),NSUInteger(commands.size()));}
struct Action {std::vector<id>commands;std::shared_ptr<Job>job;};
struct Submission:std::enable_shared_from_this<Submission>{
 id queue=nil;std::shared_ptr<QueueOrder>order;std::shared_ptr<Group>group;std::vector<Action>actions;size_t index=0;bool forced=false;
 void native(const std::vector<id>&buffers,std::shared_ptr<Job>cancel={}){if(@available(macOS 26.0,*)){
  auto options=[MTL4CommitOptions new];auto g=group;[options addFeedbackHandler:^(id<MTL4CommitFeedback>report){if(report.error&&cancel){cancel->canceled=true;if(cancel->slot->event.signaledValue<cancel->ready)cancel->slot->event.signaledValue=cancel->ready;}g->complete(report.GPUStartTime,report.GPUEndTime,report.error);}];nativeCommit(queue,buffers,options);
 }}
 void original(std::shared_ptr<Job>job,bool late=false){if(!job->original||job->originalSubmitted)return;job->originalSubmitted=true;job->lateOriginal=late;if(job->callbacks.originalKept)job->callbacks.originalKept();auto self=shared_from_this();auto g=group;if(@available(macOS 26.0,*)){
  if(job->publishing){Internal scope;[queue waitForEvent:job->slot->event value:job->published];}
  auto options=[MTL4CommitOptions new];[options addFeedbackHandler:^(id<MTL4CommitFeedback>report){std::lock_guard guard(self->order->mutex);job->originalCompleted=true;if(report.error&&job->slot->event.signaledValue<job->originalReady)job->slot->event.signaledValue=job->originalReady;if(job->afterOriginal){auto callback=std::move(job->afterOriginal);callback();}g->complete(report.GPUStartTime,report.GPUEndTime,report.error);}];nativeCommit(queue,{job->original},options);Internal scope;[queue signalEvent:job->slot->event value:job->originalReady];if(late)[queue signalEvent:job->slot->event value:job->done];
 }}
 void clear(){if(order->pending==this){order->pending=nullptr;order->flush={};}}
 void continueAfter(const std::shared_ptr<Job>&job){if(forced)return;clear();{Internal scope;[queue waitForEvent:job->slot->event value:job->done];}++index;if(index<actions.size())start();}
 void finish(const std::shared_ptr<Job>&job,ShaderResult outcome,double first,double last,NSError*error,bool originalOnly=false){if(job->finalized)return;job->finalized=true;job->outcome=std::move(outcome);if(originalOnly&&job->callbacks.originalOutputRetained)job->callbacks.originalOutputRetained();if(job->callbacks.publicationCompleted)job->callbacks.publicationCompleted(job->outcome);group->complete(first,last,error);continueAfter(job);}
 // A later producer operation wins. If a tentative publication already runs,
 // its GPU signal orders the original SDK after that write. The complete SDK
 // image then wins this frame; no suffix is authorized for the cancelled graph.
 void flush(){if(forced)return;forced=true;clear();auto current=actions[index].job;original(current,current->publishing);{Internal scope;[queue waitForEvent:current->slot->event value:current->done];}
  for(size_t n=index+1;n<actions.size();++n){auto&action=actions[n];native(action.commands);if(action.job){auto job=action.job;job->active=false;if(job->callbacks.submitted)job->callbacks.submitted(false,nil,0);job->commands=nil;job->publication=nil;original(job);group->complete(0,0,nil);}}
 }
 void publish(std::shared_ptr<Job>job,id<MTLCommandBuffer>completed,bool success){
  // The SDK may be omitted only after the final target copy actually completes.
  // Earlier admission is read-only; a later history/queue dependency can still
  // require the untouched original-only recording.
  const bool tentative=success&&!forced&&job->original&&job->callbacks.mayOmitOriginal&&job->callbacks.mayOmitOriginal();if(!tentative)original(job);
  auto commands=job->publication;if(job->originalSubmitted)[commands encodeWaitForEvent:job->slot->event value:job->originalReady];auto result=job->callbacks.publish?job->callbacks.publish(commands,success):ShaderResult{false,"No prepared Metal 4 publication path"};
  if(!result.encoded){job->outcome=result;success=false;original(job);if(job->originalSubmitted)[commands encodeWaitForEvent:job->slot->event value:job->originalReady];result=job->callbacks.publish?job->callbacks.publish(commands,false):ShaderResult{false,"No complete Metal 4 fallback publication"};}
  auto self=shared_from_this();auto failure=job->outcome;
  if(!commands||!result.encoded){auto error=[NSError errorWithDomain:@"org.maclauncher.graphics.bridge" code:1 userInfo:@{NSLocalizedDescriptionKey:@"The Metal 4 publication command could not be recorded"}];auto drain=[self,job,completed,error]{if(job->slot->event.signaledValue<job->done)job->slot->event.signaledValue=job->done;self->finish(job,{false,"The complete original SDK image was retained after publication failed"},completed.GPUStartTime,completed.GPUEndTime,error,true);};if(job->originalSubmitted&&!job->originalCompleted)job->afterOriginal=drain;else drain();return;}
  const bool provisional=tentative&&success&&!job->originalSubmitted;job->publishing=provisional;
  [commands encodeSignalEvent:job->slot->event value:provisional?job->published:job->done];
  [commands addCompletedHandler:^(id<MTLCommandBuffer>done){std::lock_guard guard(self->order->mutex);const bool copied=done.status==MTLCommandBufferStatusCompleted;auto error=completed.error?:done.error;
   if(provisional){if(!copied&&job->slot->event.signaledValue<job->published)job->slot->event.signaledValue=job->published;const bool omit=copied&&!self->forced&&job->callbacks.omitOriginal&&job->callbacks.omitOriginal();if(omit){self->group->complete(0,0,nil);{Internal scope;[self->queue signalEvent:job->slot->event value:job->done];}self->finish(job,job->outcome,completed.GPUStartTime,done.GPUEndTime,error);}else{self->original(job,true);self->finish(job,{false,"The complete original SDK image was retained for a later producer or history dependency"},completed.GPUStartTime,done.GPUEndTime,error,copied&&!completed.error);}}
   else{if(!copied&&job->slot->event.signaledValue<job->done)job->slot->event.signaledValue=job->done;self->finish(job,copied?(success?job->outcome:failure):ShaderResult{false,"The shared Metal 4 publication failed"},completed.GPUStartTime,done.GPUEndTime,error,copied&&!success&&!completed.error);}
  }];job->publication=nil;[commands commit];
 }
 void start(){if(@available(macOS 26.0,*)){
  auto&action=actions[index];native(action.commands,action.job);if(!action.job){clear();return;}auto job=action.job;auto self=shared_from_this();order->pending=this;order->flush=[self]{self->flush();};if(job->callbacks.submitted)job->callbacks.submitted(true,job->slot->event,job->done);{Internal scope;[queue signalEvent:job->slot->event value:job->ready];}auto commands=job->commands;job->commands=nil;{std::lock_guard sequence(job->pool->sequencing);[commands enqueue];[job->publication enqueue];}
  [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){std::lock_guard guard(self->order->mutex);bool success=completed.status==MTLCommandBufferStatusCompleted&&!job->canceled.load();if(success&&job->callbacks.completion){job->outcome=job->callbacks.completion();success=job->outcome.encoded;}else job->outcome=success?ShaderResult{true,{}}:ShaderResult{false,job->canceled.load()?"The producer Metal 4 prefix failed":"The shared GPU command failed"};self->publish(job,completed,success);}];[commands commit];
 }}
};
void commit(id queue,const id*commands,NSUInteger count,id options){
 if(@available(macOS 26.0,*)){
  if(internal){nativeCommit(queue,std::vector<id>(commands,commands+count),options);return;}
  auto order=queueOrder(queue);std::lock_guard ordered(order->mutex);flushQueue(queue);
  std::vector<id>flat,batch;std::vector<Action>actions;std::vector<std::shared_ptr<Record>>records;bool split=false,known=!options||objc_getAssociatedObject(options,&optionsKey);auto box=(MLMetal4QueueBox*)objc_getAssociatedObject(queue,&queueKey);dispatch_queue_t feedbackQueue=box.feedbackQueue;
  for(NSUInteger i=0;i<count;++i){auto value=record(commands[i]);if(!value||value->segments.empty()){flat.push_back(commands[i]);batch.push_back(commands[i]);continue;}std::lock_guard guard(value->mutex);split=true;records.push_back(value);known=known&&value->ended&&value->encoders==0&&value->current&&[queue device]==value->pool->device;
   if(value->submission.queue){known=known&&value->submission.queue==queue&&value->submission.options==options;feedbackQueue=value->submission.feedbackQueue;}
   for(auto&segment:value->segments){flat.push_back(segment.commands);batch.push_back(segment.commands);if(segment.after){if(segment.after->original)flat.push_back(segment.after->original);if(segment.after->active){actions.push_back({std::move(batch),segment.after});batch.clear();}}}
   flat.push_back(value->current);batch.push_back(value->current);value->submitted=true;
  }
  if(!split){nativeCommit(queue,flat,options);return;}
  if(!known){
   for(auto&value:records)for(auto&segment:value->segments)if(segment.after){auto job=segment.after;job->active=false;if(job->callbacks.originalKept)job->callbacks.originalKept();if(job->callbacks.submitted)job->callbacks.submitted(false,nil,0);job->commands=nil;job->publication=nil;}
   nativeCommit(queue,flat,options);auto retire=[MTL4CommitOptions new];auto group=std::make_shared<Group>();group->remaining=1;group->records=records;group->buffers=flat;group->callbackQueue=feedbackQueue;[retire addFeedbackHandler:^(id<MTL4CommitFeedback>report){group->complete(report.GPUStartTime,report.GPUEndTime,report.error);}];auto tail=records.back()->segments.back().after->slot;{Internal scope;[tail->retirement beginCommandBufferWithAllocator:tail->allocator];[tail->retirement endCommandBuffer];}nativeCommit(queue,{tail->retirement},retire);return;
  }
  if(!batch.empty())actions.push_back({std::move(batch),nullptr});
  auto group=std::make_shared<Group>();group->records=records;group->buffers=flat;group->callbackQueue=feedbackQueue;group->nativeQueue=queue;auto feedbackSlot=records.back()->segments.back().after->slot;{Internal scope;[feedbackSlot->retirement beginCommandBufferWithAllocator:feedbackSlot->allocator];[feedbackSlot->retirement endCommandBuffer];}group->feedbackCommands=feedbackSlot->retirement;
  if(options){auto metadata=(MLMetal4OptionsBox*)objc_getAssociatedObject(options,&optionsKey);@synchronized(metadata){group->handlers=[metadata.handlers copy];}}
  for(auto&action:actions)group->remaining+=1+unsigned(action.job!=nullptr)+unsigned(action.job&&action.job->original);
  auto submission=std::make_shared<Submission>();submission->queue=queue;submission->order=order;submission->group=group;submission->actions=std::move(actions);submission->start();return;
 }
 nativeCommit(queue,std::vector<id>(commands,commands+count),options);
}
void commitPlain(id self,SEL,const id*commands,NSUInteger count){commit(self,commands,count,nil);}
void commitOptions(id self,SEL,const id*commands,NSUInteger count,id options){commit(self,commands,count,options);}
template<class...A>void orderedOperation(id self,SEL selector,A...arguments){if(internal){invoke<void>(self,selector,arguments...);return;}auto order=queueOrder(self);std::lock_guard guard(order->mutex);flushQueue(self);invoke<void>(self,selector,arguments...);}
void queueEvent(id self,SEL selector,id event,uint64_t value){orderedOperation(self,selector,event,value);}
void queueObject(id self,SEL selector,id object){orderedOperation(self,selector,object);}
void queueObjects(id self,SEL selector,const id*objects,NSUInteger count){orderedOperation(self,selector,objects,count);}
API_AVAILABLE(macos(26.0))
void queueTextureMappings(id self,SEL selector,id texture,id heap,const MTL4UpdateSparseTextureMappingOperation*operations,NSUInteger count){orderedOperation(self,selector,texture,heap,operations,count);}
API_AVAILABLE(macos(26.0))
void queueCopyTextureMappings(id self,SEL selector,id source,id target,const MTL4CopySparseTextureMappingOperation*operations,NSUInteger count){orderedOperation(self,selector,source,target,operations,count);}
API_AVAILABLE(macos(26.0))
void queueBufferMappings(id self,SEL selector,id buffer,id heap,const MTL4UpdateSparseBufferMappingOperation*operations,NSUInteger count){orderedOperation(self,selector,buffer,heap,operations,count);}
API_AVAILABLE(macos(26.0))
void queueCopyBufferMappings(id self,SEL selector,id source,id target,const MTL4CopySparseBufferMappingOperation*operations,NSUInteger count){orderedOperation(self,selector,source,target,operations,count);}
void installQueue(id queue,dispatch_queue_t feedbackQueue){if(!queue)return;if(@available(macOS 26.0,*)){queueOrder(queue);auto metadata=(MLMetal4QueueBox*)objc_getAssociatedObject(queue,&queueKey);metadata.feedbackQueue=feedbackQueue;const auto cls=object_getClass(queue);hook(cls,@selector(commit:count:),(IMP)commitPlain);hook(cls,@selector(commit:count:options:),(IMP)commitOptions);
 hook(cls,@selector(signalEvent:value:),(IMP)queueEvent);hook(cls,@selector(waitForEvent:value:),(IMP)queueEvent);
 for(SEL selector:{@selector(signalDrawable:),@selector(waitForDrawable:),@selector(addResidencySet:),@selector(removeResidencySet:)})hook(cls,selector,(IMP)queueObject);
 hook(cls,@selector(addResidencySets:count:),(IMP)queueObjects);hook(cls,@selector(removeResidencySets:count:),(IMP)queueObjects);
 hook(cls,@selector(updateTextureMappings:heap:operations:count:),(IMP)queueTextureMappings);hook(cls,@selector(copyTextureMappingsFromTexture:toTexture:operations:count:),(IMP)queueCopyTextureMappings);hook(cls,@selector(updateBufferMappings:heap:operations:count:),(IMP)queueBufferMappings);hook(cls,@selector(copyBufferMappingsFromBuffer:toBuffer:operations:count:),(IMP)queueCopyBufferMappings);
}}
static id newQueue(id self,SEL selector) __attribute__((ns_returns_retained));
static id newQueue(id self,SEL selector){id value=invokeRetained(self,selector);installQueue(value,nullptr);return value;}
static id newQueueOptions(id self,SEL selector,id descriptor,NSError*__autoreleasing*error) __attribute__((ns_returns_retained));
static id newQueueOptions(id self,SEL selector,id descriptor,NSError*__autoreleasing*error){id value=invokeRetained(self,selector,descriptor,error);installQueue(value,[descriptor feedbackQueue]);return value;}
}
namespace macfx {
struct Metal4ClassicBridge::Impl {std::shared_ptr<m4bridge::Pool>pool;explicit Impl(id<MTLDevice>device):pool(std::make_shared<m4bridge::Pool>()){pool->device=device;}};
Metal4ClassicBridge::Metal4ClassicBridge(id<MTLDevice>device):impl(std::make_shared<Impl>(device)){}
Metal4ClassicBridge::~Metal4ClassicBridge()=default;
void Metal4ClassicBridge::install(id<MTLDevice>device){if(@available(macOS 26.0,*)){using namespace m4bridge;hook(object_getClass(device),@selector(newCommandBuffer),(IMP)newCommands);hook(object_getClass(device),@selector(newMTL4CommandQueue),(IMP)newQueue);hook(object_getClass(device),@selector(newMTL4CommandQueueWithDescriptor:error:),(IMP)newQueueOptions);installFeedbackClass([MTL4CommitOptions class]);hook(object_getClass([MTL4CommitOptions class]),@selector(allocWithZone:),(IMP)allocateOptions);}}
id Metal4ClassicBridge::recordingTarget(id commands){return m4bridge::target(commands);}
ShaderResult Metal4ClassicBridge::prepare(unsigned capacity){@autoreleasepool{@try{try{if(@available(macOS 26.0,*)){
 if([NSThread isMainThread])return {false,"Prepare Metal 4 bridge resources on the graphics worker",true};if(!capacity||capacity>16||!impl->pool->device)return {false,"Invalid Metal 4 bridge capacity/device"};install(impl->pool->device);auto pool=impl->pool;std::lock_guard guard(pool->mutex);if(!pool->queue)pool->queue=[pool->device newCommandQueue];if(!pool->queue)return {false,"Cannot create the shared classic processing queue"};m4bridge::Internal internal;if(!pool->nativeProbe){pool->nativeProbe=[pool->device newMTL4CommandQueue];m4bridge::installQueue(pool->nativeProbe,nullptr);}
 auto allocate=[&]{auto slot=std::make_shared<m4bridge::Slot>();slot->event=[pool->device newSharedEvent];slot->allocator=[pool->device newCommandAllocator];slot->commands=[pool->device newCommandBuffer];slot->original=[pool->device newCommandBuffer];slot->retirement=[pool->device newCommandBuffer];if(!slot->event||!slot->allocator||!slot->commands||!slot->original||!slot->retirement)throw std::runtime_error("Cannot prepare bounded Metal 4 continuation resources");return slot;};
 for(auto&slot:pool->slots)if(slot->failed.load()&&!slot->busy.load())slot=allocate();while(pool->slots.size()<capacity)pool->slots.push_back(allocate());return {true,{}};
 }return {false,"Metal 4 requires macOS 26 or later"};}catch(const std::exception&error){return {false,error.what()};}}@catch(NSException*error){return {false,error.reason.UTF8String?:"Metal 4 bridge preparation failed"};}}}
id<MTLCommandQueue>Metal4ClassicBridge::classicQueue()const{std::lock_guard guard(impl->pool->mutex);return impl->pool->queue;}
bool Metal4ClassicBridge::needsPreparation()const{std::lock_guard guard(impl->pool->mutex);for(const auto&slot:impl->pool->slots)if(slot->failed.load())return true;return false;}
ShaderResult Metal4ClassicBridge::declareSubmission(id commands,const Metal4SubmissionContext&context){if(@available(macOS 26.0,*)){auto value=m4bridge::record(commands);if(!value||!value->begun||value->ended)return {false,"Needs an observed current Metal 4 recording"};if(!context.queue||[context.queue device]!=impl->pool->device)return {false,"Needs the actual Metal 4 submission queue"};if(context.options&&!objc_getAssociatedObject(context.options,&m4bridge::optionsKey))return {false,"The preexisting Metal 4 commit options are unobserved"};std::lock_guard guard(value->mutex);value->submission=context;value->pool=impl->pool;m4bridge::installQueue(context.queue,context.feedbackQueue);return {true,{}};}return {false,"Metal 4 requires macOS 26 or later"};}
ShaderResult Metal4ClassicBridge::encode(id commands,Metal4ClassicJob callbacks,bool*originalEncoded){@autoreleasepool{@try{try{if(@available(macOS 26.0,*)){
 if(originalEncoded)*originalEncoded=callbacks.completeProducerImage;if(!callbacks.completeProducerImage&&(!callbacks.recordOriginal||!originalEncoded))return {false,"Metal 4 ingress needs its exact original-SDK recording and receipt"};if(!callbacks.encode||!callbacks.publish)return {false,"Metal 4 bridge needs prepared processing and publication callbacks"};auto value=m4bridge::record(commands);if(!value){m4bridge::installCommands(object_getClass(commands));return {false,"The current Metal 4 recording predates the adapter; its next begin will be observed"};}std::lock_guard guard(value->mutex);if(!value->begun||value->ended||value->submitted||value->encoders||value->suspended)return {false,"Needs a closed, unsuspended Metal 4 encoder boundary"};auto pool=impl->pool;std::shared_ptr<m4bridge::Slot>slot;{std::lock_guard lock(pool->mutex);if(!pool->queue)return {false,"Prepare the Metal 4 bridge first",true};for(auto&candidate:pool->slots){if(candidate->failed.load())continue;bool free=false;if(candidate->busy.compare_exchange_strong(free,true)){slot=candidate;break;}}}if(!slot)return {false,"The bounded Metal 4 continuation pool is busy",true};m4bridge::SlotReservation reservation{slot};
 auto job=std::make_shared<m4bridge::Job>();job->slot=slot;job->pool=pool;job->callbacks=std::move(callbacks);job->ready=++slot->generation;job->published=++slot->generation;job->originalReady=++slot->generation;job->done=++slot->generation;job->commands=[pool->queue commandBuffer];job->publication=[pool->queue commandBuffer];if(!job->commands||!job->publication)return {false,"Cannot prepare the Metal 4 processing/publication command pair"};[job->commands encodeWaitForEvent:slot->event value:job->ready];
 struct Rejected {std::shared_ptr<m4bridge::Job>job;bool kept=false;~Rejected(){if(!kept){if(job->callbacks.submitted)job->callbacks.submitted(false,nil,0);if(job->callbacks.retired)job->callbacks.retired({false,"The optional Metal 4 recording was not accepted"});}}}rejected{job};
 auto result=job->callbacks.encode(job->commands);job->callbacks.encode={};if(!result.encoded)return result;
 value->segments.reserve(value->segments.size()+1);m4bridge::Internal internal;
 // Prepare both native recordings before consuming the original SDK call. The
 // SDK-only segment is retained unchanged for unknown-options/error fallback.
 [slot->allocator reset];auto begin=[&](id object){if(value->beginOptions)[object beginCommandBufferWithAllocator:slot->allocator options:value->beginOptions];else[object beginCommandBufferWithAllocator:slot->allocator];[object setLogState:[value->current logState]];[object setLabel:[value->current label]];for(id set in value->residency)[object useResidencySet:set];for(NSString*label in value->debug)[object pushDebugGroup:label];};begin(slot->commands);reservation.started=true;
 if(job->callbacks.isolateOriginal&&!job->callbacks.completeProducerImage){begin(slot->original);job->original=slot->original;}
 if(job->callbacks.producerFence){
  if(job->original){id<MTL4ComputeCommandEncoder>wait=[(id<MTL4CommandBuffer>)value->current computeCommandEncoder];if(!wait)return {false,"Cannot prepare the original SDK input-fence boundary"};[wait waitForFence:job->callbacks.producerFence beforeEncoderStages:MTLStageDispatch|MTLStageBlit];[wait endEncoding];}
  id<MTL4ComputeCommandEncoder>barrier=[(id<MTL4CommandBuffer>)slot->commands computeCommandEncoder];if(!barrier)return {false,"Cannot prepare the Metal 4 producer fence continuation"};[barrier updateFence:job->callbacks.producerFence afterEncoderStages:MTLStageDispatch|MTLStageBlit];[barrier endEncoding];
 }
 if(!job->callbacks.completeProducerImage){auto original=job->callbacks.recordOriginal(job->original?:value->current);if(!original.encoded)return original;*originalEncoded=true;if(job->original){for(NSUInteger i=0;i<value->debug.count;++i)[job->original popDebugGroup];[job->original endCommandBuffer];}else if(job->callbacks.originalKept)job->callbacks.originalKept();}job->callbacks.recordOriginal={};
 auto alias=[MLMetal4AliasBox new];alias->value=value;objc_setAssociatedObject(slot->commands,&m4bridge::aliasKey,alias,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
 for(NSUInteger i=0;i<value->debug.count;++i)[value->current popDebugGroup];[value->current endCommandBuffer];rejected.kept=true;
 value->segments.push_back({value->current,job});value->current=slot->commands;value->pool=pool;reservation.retained=true;return {true,{}};
 }return {false,"Metal 4 requires macOS 26 or later"};}catch(const std::exception&error){return {false,error.what()};}}@catch(NSException*error){return {false,error.reason.UTF8String?:"Metal 4 recording could not be continued"};}}}
}
