// SPDX-License-Identifier: MIT
#pragma once
// The camera that a game supplies after its frame's upscaling evaluation, for that frame's generation stage.
// Unreal Engine's Streamline plugin sets each frame's constants after its own NGX DLSS evaluation of the frame, so
// the evaluation carries no camera. The NGX core in the game process matches those constants to the evaluation they
// follow and publishes the camera with that evaluation's exact jitter offset in effect-plan.temporal-camera, a
// fixed-size file beside effect-plan.json that the NGX core creates and clears at its first direct evaluation; both
// sides map it once. Each slot is a
// sequence-locked record: an odd sequence while it is written, the next even one when it is complete.
// A generation stage takes a camera only for a scene without one, from one of the two newest records, when that
// record's jitter offset equals the scene's bit for bit, is nonzero, and no other record carries the same offset,
// and when the depth direction agrees. A jitter sequence that repeats within three frames therefore never binds.
// Temporal upscaling needs the camera at the evaluation and never uses this record.
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include "temporal-camera.h"
#include "temporal-frame.h"

namespace late_camera {
constexpr uint32_t magic = 0x4d43544cu, version = 1, slots = 4, fileSize = 4096;
struct Slot {
  uint64_t sequence, publication; // publication: 1-based; the slot is (publication - 1) % slots
  float jitterX, jitterY;
  uint64_t evaluation;            // the NGX core's number of the evaluation the camera follows
  RSTemporalCamera camera;
};
struct Mailbox {
  uint32_t magic, version, slotCount, reserved;
  uint64_t published;
  Slot slot[slots];
};
static_assert(sizeof(Slot) == 96 && sizeof(Mailbox) == 408 && sizeof(Mailbox) <= fileSize, "late camera layout");

enum Result { Bound, NoMailbox, NoRecord, NotNewest, Ambiguous, DepthDirection, Unjittered };

inline bool sameBits(float a, float b) { return std::memcmp(&a, &b, sizeof(a)) == 0; }

// Reads one complete record; false while the writer holds it or when it changed during the read.
inline bool read(const Slot &source, Slot &out) {
  const uint64_t before = __atomic_load_n(&source.sequence, __ATOMIC_ACQUIRE);
  if (!before || (before & 1))
    return false;
  out.publication = source.publication;
  out.jitterX = source.jitterX;
  out.jitterY = source.jitterY;
  out.evaluation = source.evaluation;
  std::memcpy(&out.camera, &source.camera, sizeof(out.camera));
  std::atomic_thread_fence(std::memory_order_acquire);
  out.sequence = before;
  return __atomic_load_n(&source.sequence, __ATOMIC_RELAXED) == before;
}

// The camera of the scene whose evaluation jitter is (jitterX, jitterY) and whose depth is reversed or not.
inline Result take(const Mailbox *mailbox, float jitterX, float jitterY, bool reversed, RSTemporalCamera &out) {
  out = {};
  if (!mailbox || __atomic_load_n(&mailbox->magic, __ATOMIC_ACQUIRE) != magic || mailbox->version != version ||
      mailbox->slotCount != slots)
    return NoMailbox;
  if (!std::isfinite(jitterX) || !std::isfinite(jitterY) || (jitterX == 0 && jitterY == 0))
    return Unjittered;
  const uint64_t published = __atomic_load_n(&mailbox->published, __ATOMIC_ACQUIRE);
  unsigned matches = 0;
  bool newest = false;
  Slot found{};
  for (uint32_t i = 0; i < slots; ++i) {
    Slot record{};
    if (!read(mailbox->slot[i], record) || record.camera.size != sizeof(RSTemporalCamera) ||
        !sameBits(record.jitterX, jitterX) || !sameBits(record.jitterY, jitterY))
      continue;
    ++matches;
    found = record;
    newest = record.publication && record.publication <= published && record.publication + 2 > published;
  }
  if (!matches)
    return NoRecord;
  if (matches > 1)
    return Ambiguous;
  if (!newest)
    return NotNewest;
  if (bool(found.camera.flags & RS_TEMPORAL_DEPTH_REVERSED) != reversed)
    return DepthDirection;
  out = found.camera;
  return Bound;
}

// The file beside RESHADE_EFFECT_PLAN, mapped read-only once per process; null without one.
inline const Mailbox *mapped() {
  static const Mailbox *mailbox = nullptr;
  static std::once_flag once;
  std::call_once(once, [] {
    const char *plan = std::getenv("RESHADE_EFFECT_PLAN");
    if (!plan || plan[0] != '/')
      return;
    std::string path(plan);
    path.resize(path.find_last_of('/') + 1);
    path += "effect-plan.temporal-camera";
    const int file = open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (file < 0)
      return;
    struct stat info {};
    if (fstat(file, &info) == 0 && info.st_size == off_t(fileSize)) {
      void *view = mmap(nullptr, fileSize, PROT_READ, MAP_SHARED, file, 0);
      if (view != MAP_FAILED)
        mailbox = static_cast<const Mailbox *>(view);
    }
    close(file);
  });
  return mailbox;
}
} // namespace late_camera
