// SPDX-License-Identifier: MIT
#include "windows-checkpoint.h"

#include "inst_system.h"
#include "inst_macros.inc"
#include "../data/savesystem.h"
#include "../mem.h"
#include "../profile/scriptvars.h"

namespace Impacto::Vm {

VmInstruction(InstWindowsAutoSave) {
  // Only the Windows checkpoint form has this extra little-endian operand.
  // Inspect its complete width before any capture or save-system side effect.
  if (thread->GetIp(3)[2] != 10) {
    InstAutoSaveOld(thread, dt);
    return;
  }
  thread->GetIp(5);
  StartInstruction;
  PopUint8(type);
  PopUint16(checkpointId);
  SaveSystem::SetCheckpointId(checkpointId);
  SetFlag(Profile::ScriptVars::SF_SAVECAPTURE, 1);
  BlockThread;
}

}  // namespace Impacto::Vm
