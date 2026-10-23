// SPDX-License-Identifier: MIT
#include "windows-sfx.h"

#include "inst_macros.inc"
#include "expression.h"
#include "../audio/audiosystem.h"
#include "../audio/audiochannel.h"
#include "../profile/scriptvars.h"
#include "../mem.h"

#include <stdexcept>

namespace Impacto::Vm {
using namespace Impacto::Profile::ScriptVars;

VmInstruction(InstWindowsSePlay) {
  // Check the whole fixed header before consuming expressions or changing
  // playback. Windows SEplay includes a type byte absent from the MO6 layout.
  const auto* header = thread->GetIp(4);
  const uint8_t channel = header[2], type = header[3];
  if (channel > 2)
    throw std::runtime_error("Unsupported Windows SC3 sound-effect channel.");
  if (type > 2)
    throw std::runtime_error("Unsupported Windows SC3 sound-effect type.");
  auto* sound = Audio::Channels[Audio::AC_SE0 + channel].get();
  if (!sound)
    throw std::runtime_error("Windows SC3 sound-effect channel is unavailable.");

  StartInstruction;
  thread->IpOffset += 2;
  if (type == 2) {
    // Resume has no expression operands and does not yield the Windows VM.
    sound->Resume();
    return;
  }
  PopExpression(effect);
  PopExpression(loop);
  if (effect < -1 || effect > 9999)
    throw std::runtime_error("Unsupported Windows SC3 sound-effect ID.");

  // An already loaded looping request must keep its playback position.
  if (effect >= 0 && loop && ScrWork[SW_SEREQNO + channel] == effect &&
      sound->IsLooping() && sound->GetStream() &&
      sound->GetState() != Audio::ACS_Stopped) {
    if (type == 1) BlockThread;
    return;
  }
  ScrWork[SW_SEREQNO + channel] = effect >= 0 && loop ? effect : 0xFFFF;
  if (effect < 0) {
    sound->Stop(0.0f);
  } else {
    sound->SetVolume((ScrWork[SW_SEVOL + channel] / 100.0f) * 0.3f);
    // VfsOpen and AudioStream construction complete synchronously. Pausing
    // here therefore preserves the Windows preload-before-resume contract.
    sound->Play("se", effect, loop != 0, 0.0f);
    if (type == 1) sound->Pause();
  }
  BlockThread;
}

}  // namespace Impacto::Vm
