// Copyright (c) MacLauncher contributors. MIT license.
// Included by the owned exact-pin Cmlx Metal device translation unit.
#include "maclauncher-metal-job.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <unordered_set>
#include <vector>
namespace maclauncher_mlx_timing {
struct Interval {double start, end;};
struct Job {
  uint64_t token=0;
  unsigned pending=0, completed=0, mlxCompleted=0;
  bool sealed=false, invalid=false, failed=false;
  MacLauncherMLXGPUCompletion completion=nullptr;
  void *context=nullptr;
  std::vector<Interval> intervals;
  std::unordered_set<MTL::CommandBuffer*> observing;
  std::vector<MTL::CommandBuffer*> buffers;
};
struct Registry {
  struct Binding {uint64_t token;bool work=false;};
  std::mutex mutex;
  std::unordered_map<uint64_t,std::shared_ptr<Job>> jobs;
  std::unordered_map<MTL::CommandBuffer*,Binding> buffers;
};
Registry&registry(){static auto *value=new Registry;return *value;}
thread_local uint64_t encodingToken=0;
uint64_t owner(MTL::CommandBuffer *buffer){auto&r=registry();std::lock_guard guard(r.mutex);auto at=r.buffers.find(buffer);return at==r.buffers.end()?0:at->second.token;}
void bind(MTL::CommandBuffer *buffer){auto&r=registry();std::lock_guard guard(r.mutex);if(encodingToken)r.buffers.try_emplace(buffer,Registry::Binding{encodingToken,false});else r.buffers.erase(buffer);}
void dispatched(MTL::CommandBuffer *buffer){auto&r=registry();std::lock_guard guard(r.mutex);auto at=r.buffers.find(buffer);if(at!=r.buffers.end())at->second.work=true;}
struct Delivery {MacLauncherMLXGPUCompletion completion=nullptr;void*context=nullptr;MacLauncherMLXGPUReceipt receipt{};std::vector<MTL::CommandBuffer*> buffers;};
Delivery terminalLocked(const std::shared_ptr<Job>&job){
  Delivery value;
  if(!job->sealed||job->pending||!job->completion)return value;
  value.completion=job->completion;value.context=job->context;job->completion=nullptr;
  value.receipt.size=sizeof(value.receipt);value.receipt.version=1;value.receipt.job_token=job->token;
  value.receipt.command_buffers=job->completed;
  value.receipt.status=job->failed?2:job->invalid||!job->mlxCompleted?1:0;
  if(value.receipt.status==0){
    std::sort(job->intervals.begin(),job->intervals.end(),[](const auto&a,const auto&b){return a.start<b.start;});
    double total=0,first=0,last=0;
    for(const auto&range:job->intervals){if(last&&range.start<=last)last=std::max(last,range.end);else{total+=last-first;first=range.start;last=range.end;}}
    total+=last-first;
    if(!std::isfinite(total)||total<=0||total>3600)value.receipt.status=1;
    else value.receipt.gpu_nanoseconds=uint64_t(std::llround(total*1e9));
  }
  value.buffers=std::move(job->buffers);registry().jobs.erase(job->token);return value;
}
void deliver(const Delivery&value){if(value.completion)value.completion(value.context,&value.receipt);for(auto buffer:value.buffers)buffer->release();}
void observe(const std::shared_ptr<Job>&job,MTL::CommandBuffer*buffer,bool mlx,bool work=true){
  auto&r=registry();
  {std::lock_guard guard(r.mutex);if(job->sealed||job->observing.count(buffer))return;
    if(job->buffers.size()>=4096){job->invalid=true;return;}
    job->observing.insert(buffer);buffer->retain();job->buffers.push_back(buffer);++job->pending;}
  buffer->addCompletedHandler([job,mlx,work](MTL::CommandBuffer*commands){
    const auto start=commands->GPUStartTime(),end=commands->GPUEndTime();Delivery terminal;
    {auto&r=registry();std::lock_guard guard(r.mutex);--job->pending;++job->completed;
      if(commands->status()!=MTL::CommandBufferStatusCompleted)job->failed=true;
      else if(!work){} // MLX also commits empty event/fence buffers between evaluations.
      else if(!std::isfinite(start)||!std::isfinite(end)||start<=0||end<=start)job->invalid=true;
      else if(job->intervals.size()>=4096)job->invalid=true;
      else {job->intervals.push_back({start,end});if(mlx)++job->mlxCompleted;}
      terminal=terminalLocked(job);
    }deliver(terminal);
  });
}
void committing(MTL::CommandBuffer*buffer){
  std::shared_ptr<Job>job;bool work=false;
  {auto&r=registry();std::lock_guard guard(r.mutex);auto at=r.buffers.find(buffer);if(at==r.buffers.end())return;auto found=r.jobs.find(at->second.token);if(found!=r.jobs.end())job=found->second;work=at->second.work;r.buffers.erase(at);}
  if(job)observe(job,buffer,true,work);
}
}
extern "C" uint64_t maclauncher_mlx_gpu_encoding_enter(uint64_t token){const auto previous=maclauncher_mlx_timing::encodingToken;maclauncher_mlx_timing::encodingToken=token;return previous;}
extern "C" void maclauncher_mlx_gpu_encoding_leave(uint64_t previous){maclauncher_mlx_timing::encodingToken=previous;}
extern "C" int maclauncher_mlx_gpu_job_begin(uint64_t token){
  if(!token)return 0;auto&r=maclauncher_mlx_timing::registry();std::lock_guard guard(r.mutex);
  if(r.jobs.size()>=64||r.jobs.count(token))return 0;
  auto job=std::make_shared<maclauncher_mlx_timing::Job>();job->token=token;r.jobs.emplace(token,std::move(job));return 1;
}
extern "C" void maclauncher_mlx_gpu_job_finish(uint64_t token,MacLauncherMLXGPUCompletion completion,void*context){
  using namespace maclauncher_mlx_timing;Delivery terminal;
  {auto&r=registry();std::lock_guard guard(r.mutex);auto at=r.jobs.find(token);
    if(at==r.jobs.end()){terminal.completion=completion;terminal.context=context;terminal.receipt={sizeof(MacLauncherMLXGPUReceipt),1,token,0,0,1};}
    else{auto job=at->second;if(job->sealed)return;job->sealed=true;job->completion=completion;job->context=context;
      for(auto buffer=r.buffers.begin();buffer!=r.buffers.end();){
        if(buffer->second.token==token){job->invalid|=buffer->second.work;buffer=r.buffers.erase(buffer);}else ++buffer;
      }
      terminal=terminalLocked(job);}
  }deliver(terminal);
}
extern "C" void maclauncher_mlx_gpu_job_observe(uint64_t token,void*command){
  if(!token||!command)return;std::shared_ptr<maclauncher_mlx_timing::Job>job;
  {auto&r=maclauncher_mlx_timing::registry();std::lock_guard guard(r.mutex);auto at=r.jobs.find(token);if(at!=r.jobs.end())job=at->second;}
  if(job)maclauncher_mlx_timing::observe(job,static_cast<MTL::CommandBuffer*>(command),false);
}
