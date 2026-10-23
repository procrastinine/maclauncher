/*
 * Copyright (C) 2016 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Exact Android 10 libunwindstack Reparse body; only Parse/MapInfo scaffolding.
// https://android.googlesource.com/platform/system/core/+/refs/heads/android10-release/libunwindstack/Maps.cpp
#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>
struct MapInfo {uint64_t start,end,flags;std::string name;};
struct LocalUpdatableMaps {
 std::vector<std::unique_ptr<MapInfo>> maps_,saved_maps_;
 std::string input;
 bool Parse(){std::ifstream in(input);std::string line;while(std::getline(in,line)){std::istringstream row(line);auto map=std::make_unique<MapInfo>();if(!(row>>std::hex>>map->start>>map->end>>map->flags))return false;std::getline(row,map->name);maps_.push_back(std::move(map));}return in.eof();}
 bool Reparse();
};
bool LocalUpdatableMaps::Reparse() {
  // New maps will be added at the end without deleting the old ones.
  size_t last_map_idx = maps_.size();
  if (!Parse()) {
    maps_.resize(last_map_idx);
    return false;
  }

  size_t total_entries = maps_.size();
  size_t search_map_idx = 0;
  for (size_t new_map_idx = last_map_idx; new_map_idx < maps_.size(); new_map_idx++) {
    auto& new_map_info = maps_[new_map_idx];
    uint64_t start = new_map_info->start;
    uint64_t end = new_map_info->end;
    uint64_t flags = new_map_info->flags;
    std::string* name = &new_map_info->name;
    for (size_t old_map_idx = search_map_idx; old_map_idx < last_map_idx; old_map_idx++) {
      auto& info = maps_[old_map_idx];
      if (start == info->start && end == info->end && flags == info->flags && *name == info->name) {
        // No need to check
        search_map_idx = old_map_idx + 1;
        maps_[new_map_idx] = nullptr;
        total_entries--;
        break;
      } else if (info->start > start) {
        // Stop, there isn't going to be a match.
        search_map_idx = old_map_idx;
        break;
      }

      // Never delete these maps, they may be in use. The assumption is
      // that there will only every be a handfull of these so waiting
      // to destroy them is not too expensive.
      saved_maps_.emplace_back(std::move(info));
      maps_[old_map_idx] = nullptr;
      total_entries--;
    }
    if (search_map_idx >= last_map_idx) {
      break;
    }
  }

  // Now move out any of the maps that never were found.
  for (size_t i = search_map_idx; i < last_map_idx; i++) {
    saved_maps_.emplace_back(std::move(maps_[i]));
    maps_[i] = nullptr;
    total_entries--;
  }

  // Sort all of the values such that the nullptrs wind up at the end, then
  // resize them away.
  std::sort(maps_.begin(), maps_.end(), [](const auto& a, const auto& b) {
    if (a == nullptr) {
      return false;
    } else if (b == nullptr) {
      return true;
    }
    return a->start < b->start;
  });
  maps_.resize(total_entries);

  return true;
}
int main(int argc,char**argv){if(argc!=3)return 2;LocalUpdatableMaps maps;maps.input=argv[1];if(!maps.Parse())return 3;maps.input=argv[2];if(!maps.Reparse())return 4;for(size_t i=1;i<maps.maps_.size();i++)if(maps.maps_[i-1]->end>maps.maps_[i]->start)return 5;std::cout<<"PASS original Android10 Reparse on original Bionic maps "<<maps.maps_.size()<<" entries\n";}
