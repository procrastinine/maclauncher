/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_VM_INPUT_H
#define ML_BGI_VM_INPUT_H
#include <stdint.h>
typedef struct {
    uint32_t maps[25][16];
    uint32_t presses[256], events[256], deadlines[256];
    uint8_t held[256], reportedHeld[256];
} MLBGI_Input;
void MLBGI_InitInput(MLBGI_Input *input);
int MLBGI_InputMapIndex(uint32_t action);
int MLBGI_SetInputMap(MLBGI_Input *input, uint32_t action, const uint32_t *keys, unsigned count);
void MLBGI_InputEvent(MLBGI_Input *input, uint32_t key, int down, int repeat, uint32_t milliseconds);
void MLBGI_ReleaseInput(MLBGI_Input *input);
void MLBGI_ClearInput(MLBGI_Input *input);
/* Reset the native counters while retaining the physical key snapshot and
   lifetime event counts, which the original queries independently. */
void MLBGI_ResetInputCounters(MLBGI_Input *input);
uint32_t MLBGI_InputEventCount(const MLBGI_Input *input, uint32_t actions);
uint32_t MLBGI_ConsumeKey(MLBGI_Input *input, uint32_t key);
int MLBGI_InputInterrupted(const MLBGI_Input *input, uint32_t actions, const uint32_t baseline[256]);
#endif
