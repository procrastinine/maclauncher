// The late camera record (late-camera.hpp): exact jitter binding of a camera set after its frame's evaluation.
#include "late-camera.hpp"
#include <cassert>
#include <chrono>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <fcntl.h>
#include <unistd.h>

static_assert(offsetof(late_camera::Slot, publication) == 8 && offsetof(late_camera::Slot, jitterX) == 16 &&
              offsetof(late_camera::Slot, evaluation) == 24 && offsetof(late_camera::Slot, camera) == 32, "slot layout");
static_assert(offsetof(late_camera::Mailbox, published) == 16 && offsetof(late_camera::Mailbox, slot) == 24, "mailbox layout");

// The NGX core's writer, as producers/vkd3d-proton/ngx_late_camera.h publishes.
static void publish(late_camera::Mailbox &m, float x, float y, uint64_t evaluation, const RSTemporalCamera &camera) {
  m.magic = late_camera::magic;m.version = late_camera::version;m.slotCount = late_camera::slots;
  const uint64_t publication = m.published + 1;auto &slot = m.slot[(publication - 1) % late_camera::slots];
  const uint64_t sequence = slot.sequence;__atomic_store_n(&slot.sequence, sequence + 1, __ATOMIC_RELAXED);
  __atomic_thread_fence(__ATOMIC_RELEASE);
  slot.publication = publication;slot.jitterX = x;slot.jitterY = y;slot.evaluation = evaluation;slot.camera = camera;
  __atomic_store_n(&slot.sequence, sequence + 2, __ATOMIC_RELEASE);__atomic_store_n(&m.published, publication, __ATOMIC_RELEASE);
}

int main() {
  using namespace late_camera;unsigned checks = 0;
  RSTemporalCamera ue{};ue.size = sizeof(ue);ue.version = 1;ue.flags = RS_TEMPORAL_DEPTH_REVERSED | RS_TEMPORAL_DEPTH_INFINITE;
  ue.frameId = 11;ue.nearPlane = 10.f;ue.farPlane = 0.f;ue.verticalFov = 1.5708f;
  RSTemporalCamera out{};Mailbox m{};
  assert(take(nullptr, .25f, -.166667f, true, out) == NoMailbox && !out.size);checks++;
  assert(take(&m, .25f, -.166667f, true, out) == NoMailbox);checks++;
  publish(m, .25f, -.166667f, 1, ue);
  assert(take(&m, .25f, -.166667f, true, out) == Bound && out.nearPlane == 10.f && out.farPlane == 0.f &&
         (out.flags & RS_TEMPORAL_DEPTH_INFINITE));checks++;
  // exact bits: the negated offset of the next frame is another frame
  assert(take(&m, -.25f, .166667f, true, out) == NoRecord && !out.size);checks++;
  assert(take(&m, 0.f, 0.f, true, out) == Unjittered);checks++;
  assert(take(&m, .25f, -.166667f, false, out) == DepthDirection && !out.size);checks++;
  // the record must be one of the two newest: a frame whose own record is not yet written never takes an older one
  publish(m, -.25f, .388889f, 2, ue);
  assert(take(&m, .25f, -.166667f, true, out) == Bound);checks++;
  publish(m, .375f, -.055556f, 3, ue);
  assert(take(&m, .25f, -.166667f, true, out) == NotNewest && !out.size);checks++;
  assert(take(&m, -.25f, .388889f, true, out) == Bound);checks++;
  // a jitter offset in two records is ambiguous
  publish(m, -.25f, .388889f, 4, ue);
  assert(take(&m, -.25f, .388889f, true, out) == Ambiguous && !out.size);checks++;
  // a record that its writer holds is not read
  publish(m, .1f, .2f, 5, ue);auto &held = m.slot[(m.published - 1) % slots];held.sequence += 1;
  assert(take(&m, .1f, .2f, true, out) == NoRecord);checks++;held.sequence += 1;
  assert(take(&m, .1f, .2f, true, out) == Bound);checks++;
  // admission when the scene is received: only after the NGX core has published a record
  Mailbox empty{};
  assert(!pending(nullptr) && !pending(&empty));checks++;
  assert(pending(&m));checks++;
  // the launcher's file beside the plan: a lookup before the file exists does not stop a later one from mapping it
  const char *temporary = std::getenv("TMPDIR");std::string pattern = std::string(temporary && *temporary ? temporary : "/tmp") + "/late-camera-XXXXXX";
  char *directory = pattern.data();assert(mkdtemp(directory));
  const std::string plan = std::string(directory) + "/effect-plan.json", file = std::string(directory) + "/effect-plan.temporal-camera";
  setenv("RESHADE_EFFECT_PLAN", plan.c_str(), 1);
  assert(!mapped(std::chrono::milliseconds(0)));checks++;
  int fd = open(file.c_str(), O_CREAT | O_RDWR | O_TRUNC, 0600);assert(fd >= 0);
  assert(!mapped(std::chrono::milliseconds(200)));checks++; // not yet its full size
  assert(ftruncate(fd, fileSize) == 0);
  assert(!mapped());checks++; // looked up again only after the retry interval, never on every frame
  usleep(250000);
  const Mailbox *view = mapped();assert(view && mapped() == view);checks++;
  assert(take(view, .25f, -.166667f, true, out) == NoMailbox && !pending(view));checks++;
  Mailbox written{};publish(written, .25f, -.166667f, 7, ue);assert(pwrite(fd, &written, sizeof(written), 0) == ssize_t(sizeof(written)));
  assert(pending(view) && take(view, .25f, -.166667f, true, out) == Bound && out.frameId == 11);checks++;
  close(fd);unlink(file.c_str());rmdir(directory);
  std::printf("late-camera: pass %u\n", checks);
}
