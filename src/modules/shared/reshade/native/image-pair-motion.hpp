#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>
namespace macfx {
struct BlockMotion {float x=0,y=0;};
inline float motionDistance(BlockMotion a,BlockMotion b){return std::hypot(a.x-b.x,a.y-b.y);}
inline float motionMedian(std::vector<float> values){
 if(values.empty())return 0;
 auto middle=values.begin()+values.size()/2;std::nth_element(values.begin(),middle,values.end());return *middle;
}
inline float smallMotionMedian(std::array<float,9> values,size_t count){
 if(!count)return 0;auto middle=values.begin()+count/2;std::nth_element(values.begin(),middle,values.begin()+count);return *middle;
}
// Independent implementation of spatial and frame-wide robust motion tests.
// Units are estimator pixels, before expansion to output pixels.
inline void filterBlockMotion(std::vector<BlockMotion>&field,unsigned width,unsigned height){
 if(!width||!height||field.size()!=size_t(width)*height)return;
 const auto original=field;
 for(unsigned y=0;y<height;++y)for(unsigned x=0;x<width;++x){
  std::array<float,9> xs,ys;size_t count=0;
  for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx){
   const auto &v=original[size_t(std::clamp(int(y)+dy,0,int(height)-1))*width+std::clamp(int(x)+dx,0,int(width)-1)];
   if(std::isfinite(v.x)&&std::isfinite(v.y)){xs[count]=v.x;ys[count++]=v.y;}
  }
  const BlockMotion median{smallMotionMedian(xs,count),smallMotionMedian(ys,count)};auto &v=field[size_t(y)*width+x];
  // Preserve coherent pans and ordinary object motion; replace isolated jumps.
  const float limit=std::max(32.f,2.f*std::hypot(median.x,median.y));
  if(!std::isfinite(v.x)||!std::isfinite(v.y)||motionDistance(v,median)>limit)v=median;
 }
 std::vector<float> xs,ys;xs.reserve(field.size());ys.reserve(field.size());
 for(auto v:field){xs.push_back(v.x);ys.push_back(v.y);}
 const BlockMotion median{motionMedian(std::move(xs)),motionMedian(std::move(ys))};
 std::vector<float> residuals;residuals.reserve(field.size());for(auto v:field)residuals.push_back(motionDistance(v,median));
 const float limit=std::max({32.f,4.f*std::hypot(median.x,median.y),8.f*motionMedian(std::move(residuals))});
 for(auto &v:field)if(motionDistance(v,median)>limit)v=median;
}
inline constexpr uint64_t maximumBorrowedFlowAge=2;
inline constexpr float borrowedFlowColorTolerance=.08f;
inline bool borrowableFlow(uint64_t requested,uint64_t completed){return completed<=requested&&requested-completed<=maximumBorrowedFlowAge;}
// Each external writer and GPU reader retains its slot. Only an unleased slot
// can be reused; exhaustion keeps the blend fallback instead of allocating more.
template<class Pair,size_t capacity=6>class ImagePairFlowPool {
 std::vector<std::shared_ptr<Pair>> slots;
public:
 void clear(){slots.clear();}
 std::shared_ptr<Pair> nearest(uint64_t sequence)const{
  std::shared_ptr<Pair> result;
  for(const auto &slot:slots)if(slot->ready.load(std::memory_order_acquire)&&borrowableFlow(sequence,slot->sequence)&&(!result||slot->sequence>result->sequence))result=slot;
  return result;
 }
 template<class Factory>std::shared_ptr<Pair> acquire(uint64_t sequence,Factory factory){
  std::shared_ptr<Pair>*available=nullptr;
  for(auto &slot:slots)if(slot.use_count()==1&&(!available||slot->sequence<(*available)->sequence))available=&slot;
  std::shared_ptr<Pair> pair;
  if(available)pair=*available;
  else{if(slots.size()>=capacity)return {};pair=factory();if(!pair)return {};slots.push_back(pair);}
  pair->ready.store(false,std::memory_order_release);pair->sequence=sequence;return pair;
 }
};
}
