#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <map>
#include <memory>
#include <mutex>
#include "image-budget.hpp"
namespace maclauncher_streamline {
struct SnapshotBudget {std::mutex mutex;uint64_t pending=0,committed=0;};
inline std::shared_ptr<SnapshotBudget>snapshotBudget(uint64_t adapter){
 static std::mutex mutex;static std::map<uint64_t,std::weak_ptr<SnapshotBudget>>values;std::lock_guard lock(mutex);auto&entry=values[adapter];auto value=entry.lock();if(!value){value=std::make_shared<SnapshotBudget>();entry=value;}return value;
}
// The COM observer and DXMT allocation share this reservation. Metadata-cache
// replacement alone cannot make live GPU image memory available again.
class SnapshotReservation {
 std::shared_ptr<SnapshotBudget>budget;uint64_t bytes;bool committed=false;
 SnapshotReservation(std::shared_ptr<SnapshotBudget>state,uint64_t count):budget(std::move(state)),bytes(count){}
public:
 SnapshotReservation(const SnapshotReservation&)=delete;
 SnapshotReservation&operator=(const SnapshotReservation&)=delete;
 static std::shared_ptr<SnapshotReservation>reserve(const std::shared_ptr<SnapshotBudget>&budget,uint64_t deviceBudget,uint64_t allocated,uint64_t bytes){
  {std::lock_guard lock(budget->mutex);const auto admission=macfx::admitImageBytes({deviceBudget,allocated,budget->committed,budget->pending},bytes);if(!admission.admitted)return{};budget->pending+=bytes;}
  SnapshotReservation*value=nullptr;try{value=new SnapshotReservation(budget,bytes);}catch(...){std::lock_guard lock(budget->mutex);budget->pending-=bytes;return{};}
  // A failed shared_ptr control-block allocation deletes its supplied object.
  try{return std::shared_ptr<SnapshotReservation>(value);}catch(...){return{};}
 }
 void commit(){std::lock_guard lock(budget->mutex);if(!committed){budget->pending-=bytes;budget->committed+=bytes;committed=true;}}
 ~SnapshotReservation(){std::lock_guard lock(budget->mutex);(committed?budget->committed:budget->pending)-=bytes;}
};
}
