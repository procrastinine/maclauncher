// SPDX-License-Identifier: MIT
#include "windows-audio.h"

#include "inst_macros.inc"
#include "expression.h"
#include "../audio/audiosystem.h"
#include "../audio/audiochannel.h"

#include <stdexcept>

namespace Impacto::Vm {
namespace {

Audio::AudioChannel* VoiceChannel(uint8_t channel) {
  // The Windows VM accepts relative voice IDs and their absolute aliases.
  if (channel >= 3 && channel <= 5) channel -= 3;
  if (channel > 2)
    throw std::runtime_error("Unsupported Windows SC3 voice channel.");
  return Audio::Channels[Audio::AC_VOICE0 + channel].get();
}

}  // namespace

VmInstruction(InstWindowsVoicePlay) {
  StartInstruction;
  PopUint8(channel);
  PopExpression(fileId);
  // The common sound request contains this expression; the voice loader does
  // not use its value. Evaluate it to preserve operand side effects and width.
  PopExpression(requestArgument);
  auto* voice = VoiceChannel(channel);
  if (fileId < 0) voice->Stop(0.0f);
  else voice->Play("voice", fileId, false, 0.0f);
  BlockThread;
}

VmInstruction(InstWindowsVoiceStop) {
  StartInstruction;
  PopUint8(channel);
  PopExpression(fadeTicks);
  if (fadeTicks < 0)
    throw std::runtime_error("Windows SC3 voice fade cannot be negative.");
  // Script fades count 60 Hz VM ticks; the audio backend takes seconds.
  VoiceChannel(channel)->Stop(static_cast<float>(fadeTicks) / 60.0f);
  BlockThread;
}

VmInstruction(InstWindowsVoiceWait) {
  StartInstruction;
  PopUint8(channel);
  if (VoiceChannel(channel)->GetState() != Audio::ACS_Stopped) {
    ResetInstruction;
    BlockThread;
  }
}

}  // namespace Impacto::Vm
