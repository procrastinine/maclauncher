/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#include "vm-input.h"
#include <string.h>
static const uint32_t actions[25] = {
    1, 2, 4, 16, 32, 64, 128, 256, 512, 4096, 8192, 16384, 32768,
    65536, 131072, 262144, 524288, 1048576, 2097152, 4194304,
    8388608, 16777216, 33554432, 0x40000000, 0x80000000
};
void MLBGI_InitInput(MLBGI_Input *input) {
    memset(input, 0, sizeof(*input));
    const uint32_t keys[25][3] = {
        {1}, {2}, {4}, {5}, {6}, {14}, {15}, {13}, {32}, {38}, {40}, {37}, {39},
        {49, 97}, {50, 98}, {51, 99}, {52, 100}, {53, 101}, {54, 102},
        {55, 103}, {56, 104}, {57, 105}, {48, 96}, {9}, {17}
    };
    for (unsigned i = 0; i < 25; i++) memcpy(input->maps[i], keys[i], sizeof(keys[i]));
}
int MLBGI_InputMapIndex(uint32_t action) {
    for (unsigned i = 0; i < 25; i++) if (actions[i] == action) return (int)i;
    return -1;
}
int MLBGI_SetInputMap(MLBGI_Input *input, uint32_t action, const uint32_t *keys, unsigned count) {
    int index = MLBGI_InputMapIndex(action);
    /* Mouse and number-key actions are fixed in this dialect. */
    if (!input || !keys || index < 5 || (index > 12 && index < 23) || count >= 16) return 0;
    for (unsigned i = 0; i < count; i++) if (!keys[i] || keys[i] > 255) return 0;
    memset(input->maps[index], 0, sizeof(input->maps[index]));
    memcpy(input->maps[index], keys, count * sizeof(*keys)); return 1;
}
void MLBGI_InputEvent(MLBGI_Input *input, uint32_t key, int down, int repeat, uint32_t milliseconds) {
    if (!input || key > 255) return;
    if (!down) { input->held[key] = input->reportedHeld[key] = 0; return; }
    input->events[key]++;
    if (!input->held[key] || (key >= 1 && key <= 6 && key != 3)) {
        input->presses[key]++; input->reportedHeld[key] = 0;
        input->deadlines[key] = milliseconds + 500;
    }
    /* Repeated key events count without creating another initial press. */
    (void)repeat; input->held[key] = 1;
}
void MLBGI_ReleaseInput(MLBGI_Input *input) {
    if (!input) return;
    memset(input->held, 0, sizeof(input->held));
    memset(input->reportedHeld, 0, sizeof(input->reportedHeld));
}
void MLBGI_ClearInput(MLBGI_Input *input) {
    MLBGI_ReleaseInput(input);
    if (!input) return;
    memset(input->presses, 0, sizeof(input->presses));
    memset(input->events, 0, sizeof(input->events));
}
void MLBGI_ResetInputCounters(MLBGI_Input *input) {
    if (!input) return;
    memset(input->presses, 0, sizeof(input->presses));
    memset(input->reportedHeld, 0, sizeof(input->reportedHeld));
    memset(input->deadlines, 0, sizeof(input->deadlines));
}
uint32_t MLBGI_InputEventCount(const MLBGI_Input *input, uint32_t selected) {
    uint32_t count = 0;
    if (!input) return 0;
    for (unsigned i = 0; i < 24; i++) if (selected & actions[i]) {
        for (unsigned k = 0; k < 16 && input->maps[i][k]; k++) count += input->events[input->maps[i][k]];
    }
    return count;
}
uint32_t MLBGI_ConsumeKey(MLBGI_Input *input, uint32_t key) {
    if (!input || key > 255) return 0;
    uint32_t count = input->presses[key]; input->presses[key] = 0;
    if (input->held[key] && !input->reportedHeld[key]) {
        count |= 0x80000000; input->reportedHeld[key] = 1;
    }
    return count;
}
int MLBGI_InputInterrupted(const MLBGI_Input *input, uint32_t selected, const uint32_t baseline[256]) {
    if (!input || !baseline) return 0;
    for (unsigned i = 0; i < 25; i++) if (selected & actions[i])
        for (unsigned k = 0; k < 16 && input->maps[i][k]; k++) {
            uint32_t key = input->maps[i][k];
            if (i == 24 ? input->held[key] : input->events[key] != baseline[key]) return 1;
        }
    return 0;
}
