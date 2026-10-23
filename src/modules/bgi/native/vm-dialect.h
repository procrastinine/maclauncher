/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_VM_DIALECT_H
#define ML_BGI_VM_DIALECT_H
#include <stdint.h>
#include <stddef.h>
#include "engine.h"
#include "state-files.h"
#include "vm-input.h"
#include "platform-text.h"

typedef enum { MLBGI_LEGACY = 0, MLBGI_ETHORNELL_172 = 1 } MLBGI_Dialect;
typedef struct { uint32_t family, size, width, style, cacheKiB; } MLBGI_FontProfile;
typedef struct MLBGI_Allocation {
    uint8_t *bytes;
    uint32_t size, tier, slot;
    struct MLBGI_Allocation *next;
} MLBGI_Allocation;
typedef struct {
    char alias[97];
    char **filenames;
    unsigned count;
} MLBGI_ArchiveGroup;
typedef struct {
    uint32_t id, maximum, bytes, count;
    uint8_t **records;
} MLBGI_RecordList;
typedef struct MLBGI_KeyedRecord {
    char *key;
    uint8_t *bytes;
    struct MLBGI_KeyedRecord *next;
} MLBGI_KeyedRecord;
typedef struct {
    uint32_t id, bytes, count;
    MLBGI_KeyedRecord *records;
} MLBGI_KeyedContainer;
typedef struct { char *name; uint32_t count; uint8_t *bits; } MLBGI_FlagGroup;
typedef struct { uint32_t value, slots[16]; } MLBGI_ObjectData;
typedef struct { char source[512], replacement[256]; } MLBGI_TextRule;
typedef struct { uint32_t priority; int32_t bounds[4]; } MLBGI_InputRoute;
typedef struct { uint32_t width, height, format; uint8_t *pixels; } MLBGI_MenuImage;
typedef struct { uint32_t values[49], group, index, images[4]; } MLBGI_MenuItem;
typedef struct {
    uint32_t header[10], (*groups)[16];
    MLBGI_MenuItem *items;
    MLBGI_MenuImage *images;
    uint32_t *imageSlots;
    unsigned itemCount, imageCount;
    size_t bytes;
} MLBGI_Menu;
typedef struct {
    uint32_t id, target, kind, enabled;
    MLBGI_Menu *menu;
    uint32_t events[1024][3];
    unsigned eventHead, eventCount;
} MLBGI_Controller;
typedef struct {
    Thread_t *thread;
    uint32_t object, startMilliseconds, duration, initialOpacity, targetOpacity;
    uint64_t initialPresentedFrames;
} MLBGI_Transition;
typedef struct {
    int allocated;
    uint32_t visible, kind, parameter, opacity, order, owner;
    uint32_t secondaryOpacity, opacityScale;
    uint64_t drawSequence;
    int32_t x, y;
    int32_t offsetX, offsetY;
    MLBGI_ObjectData data;
} MLBGI_Filter;
typedef struct {
    MLBGI_Filter object;
    uint32_t bitmapSlot, blendMode;
    MLBGI_MenuImage image;
} MLBGI_Sprite;
typedef struct { uint32_t handle; int32_t x, y; } MLBGI_GroupMember;
typedef struct {
    int allocated;
    uint32_t visible, opacity, owner, memberCount;
    uint32_t secondaryOpacity, opacityScale;
    int32_t x, y;
    int32_t offsetX, offsetY;
    MLBGI_ObjectData data;
    MLBGI_GroupMember members[1024];
} MLBGI_Group;
typedef struct {
    int allocated;
    uint32_t width, height, visible, opacity, order, blendMode, owner;
    uint32_t secondaryOpacity, opacityScale;
    uint64_t drawSequence;
    int32_t x, y;
    int32_t offsetX, offsetY;
    MLBGI_ObjectData data;
    uint8_t *pixels; /* Straight-alpha native window canvas. */
    int backgroundEnabled;
    uint32_t textX, textY, textWidth, textHeight;
    uint32_t textLineSpacingPercent;
    uint32_t fontFamily, fontHeight, fontWidthPercent, fontStyle, fontColor, textReserveLine;
    uint32_t textDirection, textAlignment;
    int32_t textCursorX, textCursorY;
    uint32_t textBackdropKnockout;
    int fontConfigured;
} MLBGI_WindowObject;
#define MLBGI_MESSAGE_CAPACITY 1024
typedef struct {
    uint32_t hash;
    char *text;
} MLBGI_PersistentString;
typedef struct {
    MLBGI_Dialect dialect;
    uint32_t backgroundPolicy;
    uint32_t displayWidths[8], displayHeights[8];
    uint32_t displaySlot, displayKind, displayFlags;
    uint32_t windowPolicy, scalingPolicy;
    uint32_t displayHotkeysEnabled, displayHotkeys[16];
    uint32_t audioChannelVolumes[16], audioEffectVolumes[128];
    uint32_t monitorWidth, monitorHeight;
    uint32_t clientWidth, clientHeight;
    int automaticClientSize;
    int windowVisible;
    int (*configureWindow)(Engine_t *engine, uint32_t kind, uint32_t width, uint32_t height);
    void (*showWindow)(Engine_t *engine, int visible);
    void (*setCaption)(Engine_t *engine, const char *caption);
    char windowCaption[3072];
    int captionConfigured;
    int (*loadBitmap)(Engine_t *engine, uint32_t slot, const char *archive, const char *filename);
    char bitmapLoadError[256];
    int (*bitmapInfo)(Engine_t *engine, uint32_t slot, uint32_t output[6]);
    int (*cropBitmap)(Engine_t *engine, uint32_t destination, uint32_t source, int32_t x, int32_t y, uint32_t width, uint32_t height);
    int (*freeBitmap)(Engine_t *engine, uint32_t slot);
    int (*createBitmap)(Engine_t *engine, uint32_t slot, uint32_t width, uint32_t height, uint32_t format);
    int (*clearBitmap)(Engine_t *engine, uint32_t slot, uint32_t color);
    int (*blitBitmap)(Engine_t *engine, uint32_t destination, int32_t x, int32_t y, uint32_t source, uint32_t mode, uint32_t opacity);
    int (*windowBitmap)(Engine_t *engine, uint32_t window, uint32_t bitmap);
    int (*exportWindowBitmap)(Engine_t *engine, uint32_t bitmap, uint32_t window);
    int (*captureScene)(Engine_t *engine, uint32_t bitmap, uint32_t maximumOrder);
    int (*drawBitmapText)(Engine_t *engine, const MLBGI_BitmapText *text, uint32_t *characters);
    /* Copies a live source image: 1 present, 0 missing, -1 invalid/failure. */
    int (*copyMenuImage)(Engine_t *engine, uint32_t slot, MLBGI_MenuImage *output);
    void *particleResources;
    uint32_t imageProtocolRateMode;
    int (*registerImageProtocol)(Engine_t *engine, uint32_t type, uint32_t slot, uint32_t count, uint32_t firstBitmap,
                                 uint32_t rateA, uint32_t rateB, uint32_t scale);
    int (*registerParticleImage)(Engine_t *engine, uint32_t slot, uint32_t bitmapSlot);
    int (*configureParticle)(Engine_t *engine, uint32_t slot, const uint32_t values[10]);
    int (*configureImageProtocol)(Engine_t *engine, uint32_t slot, const uint32_t values[17]);
    void (*freeParticleResources)(Engine_t *engine);
    uint32_t frameMilliseconds, lastFrameMilliseconds;
    uint64_t presentedFrames;
    MLBGI_Transition transitions[64];
    uint32_t skipInterval, skipDeadline;
    uint32_t skipKeysEnabled, skipOutputEnabled, skipOverride;
    int skipLatch, windowFocused;
    uint32_t keyboardRoutes[256];
    MLBGI_InputRoute mouseRoutes[256];
    unsigned keyboardRouteCount, mouseRouteCount;
    uint32_t frameFlags, imageCacheLimit, imageCacheBytes;
    uint32_t presentationPolicy, renderConfiguration, codecOptions[2];
    uint32_t effectOpacityEnabled, effectOpacity;
    uint32_t canvasEnabled, canvasBackground;
    uint32_t randomState, closeDisabled;
    uint32_t cursorDelay, cursorDeadline;
    int cursorDelayEnabled, cursorVisible;
    int32_t cursorX, cursorY;
    int launcherContext;
    char *names[256];
    uint32_t nameFlags[256];
    int32_t fontTransforms[256][4];
    unsigned nameCount;
    /* Native namespace 0x80000000 is separate from font-family IDs. */
    MLBGI_PersistentString *persistentStrings;
    unsigned persistentStringCount, persistentStringCapacity;
    size_t persistentStringBytes;
    MLBGI_FontProfile fonts[64];
    unsigned fontCount, antialiasLevel;
    uint32_t responseDelay, saveCryptPolicy;
    char *searchPaths[64];
    unsigned searchPathCount;
    uint32_t searchDirectoriesEnabled;
    uint32_t animationPolicy, renderAttributes[6], actorPolicy;
    uint32_t wheelObjectNavigation;
    uint32_t drawOrderBase;
    int32_t rootOffsetX, rootOffsetY;
    MLBGI_ObjectData rootData;
    int drawOrderDirty;
    uint64_t drawSequence;
    int32_t textTiming[2];
    uint32_t textShadowEnabled, textShadowWidthPercent, textShadowHeightPercent, textShadowOpacity;
    MLBGI_TextRule textRules[64];
    unsigned textRuleCount;
    MLBGI_Filter filters[8];
    MLBGI_Sprite sprites[512];
    unsigned spriteCount;
    unsigned filterCount;
    MLBGI_Group groups[8];
    unsigned groupCount;
    MLBGI_WindowObject windows[16];
    unsigned windowCount;
    MLBGI_Controller controllers[64];
    uint32_t lastControllerId;
    unsigned controllerCount;
    uint32_t bitmapConfiguration;
    uint32_t renderPairs[3][2];
    uint32_t rubyConfiguration[6];
    uint32_t renderRequiresFocus;
    MLBGI_Files files;
    MLBGI_Input input;
    char projectIdentifier[97];
    int framePending;
    unsigned startupServices;
    MLBGI_Allocation **allocationSlots[5];
    MLBGI_Allocation *allocations;
    uint32_t nextAllocationSlot[5];
    size_t allocatedBytes;
    MLBGI_ArchiveGroup archiveGroups[64];
    unsigned archiveGroupCount;
    uint32_t (*createThread)(Thread_t *parent, const char *archive, const char *filename,
                             uint32_t stackWords, uint32_t codeBytes, uint32_t localBytes);
    uint32_t messages[MLBGI_MESSAGE_CAPACITY][3];
    unsigned messageHead, messageCount;
    MLBGI_RecordList recordLists[64];
    uint32_t lastRecordListId;
    size_t recordBytes;
    MLBGI_KeyedContainer keyedContainers[64];
    uint32_t lastKeyedContainerId;
    size_t keyedBytes;
    MLBGI_FlagGroup flagGroups[64];
    size_t flagBytes;
} MLBGI_Runtime;

int MLBGI_ConfigureDialect(Engine_t *engine, const char *name, uint32_t monitorWidth, uint32_t monitorHeight);
void MLBGI_FreeDialect(Engine_t *engine);
int MLBGI_IsModern(const Thread_t *thread);
uint32_t MLBGI_LocalAddress(Thread_t *thread, uint32_t offset);
uint32_t MLBGI_CodeAddress(Thread_t *thread, uint32_t offset);
uint8_t *MLBGI_ResolveAddress(Thread_t *thread, uint32_t address);
uint32_t MLBGI_AllocateMemory(Engine_t *engine, uint32_t bytes);
int MLBGI_FreeMemory(Engine_t *engine, uint32_t address);
int MLBGI_RegisterArchiveGroup(Engine_t *engine, const char *alias, const char *const *names, unsigned count);
uint8_t *MLBGI_ReadEngineResource(Engine_t *engine, const char *archive, const char *filename, size_t *bytes);
/* One interpreter-local FIFO; native input and scripts use the same triplets. */
int MLBGI_PostMessage(Engine_t *engine, uint32_t type, uint32_t first, uint32_t second);
int MLBGI_PostControllerEvent(Engine_t *engine, uint32_t id, uint32_t type, uint32_t first, uint32_t second);
int MLBGI_ApplyFilter(const Engine_t *engine, uint32_t handle, uint8_t *rgba, size_t bytes);
int MLBGI_DrawWindow(const Engine_t *engine, uint32_t handle, uint8_t *rgba, size_t capacity, uint32_t width, uint32_t height, size_t stride);
int MLBGI_DrawScene(const Engine_t *engine, uint8_t *rgba, size_t capacity, uint32_t width, uint32_t height, size_t stride);
int MLBGI_DrawSceneThroughOrder(const Engine_t *engine, uint32_t maximumOrder, uint8_t *rgba, size_t capacity, uint32_t width, uint32_t height, size_t stride);
uint32_t MLBGI_WindowLineHeight(const Engine_t *engine, uint32_t handle);
uint32_t MLBGI_ReadInteger(Thread_t *thread, const uint8_t *pointer, uint8_t width);
uint32_t MLBGI_WriteInteger(Thread_t *thread, uint8_t *pointer, uint8_t width, uint32_t value);
int MLBGI_ShouldExecute(const Engine_t *engine, int windowFocused);
int MLBGI_WindowCloseAllowed(const Engine_t *engine);
int MLBGI_ShouldRender(const Engine_t *engine, int windowFocused);
int MLBGI_DisplayHotkey(const Engine_t *engine, uint32_t key);
int MLBGI_UpdateCursor(Engine_t *engine, int windowFocused, int32_t x, int32_t y, uint32_t width, uint32_t height, uint32_t milliseconds);
uint32_t MLBGI_Milliseconds(void);
const char *MLBGI_ReadString(Thread_t *thread, uint32_t address, size_t maximumBytes);
uint32_t MLBGI_WriteString(Thread_t *thread, uint32_t address, const char *value);
int MLBGI_FrameDue(const Engine_t *engine, uint32_t milliseconds);
int MLBGI_ThreadReady(Thread_t *thread, uint32_t milliseconds);
int MLBGI_SkipWait(Engine_t *engine, int skipHeld, uint32_t milliseconds);
void MLBGI_FramePresented(Engine_t *engine, uint32_t milliseconds);
int MLBGI_AccountBitmap(Engine_t *engine, size_t oldBytes, size_t newBytes);
/* Returns 1 only for an implemented service. Unknowns retain fatal dispatch. */
int MLBGI_TryService(Thread_t *thread, uint8_t group, uint8_t service, uint32_t *result);
uint32_t MLBGI_DispatchSys1(Thread_t *thread);
uint32_t MLBGI_FixedSine(Thread_t *thread);
uint32_t MLBGI_FixedCosine(Thread_t *thread);
#endif
