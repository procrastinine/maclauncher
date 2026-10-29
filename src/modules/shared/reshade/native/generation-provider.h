#pragma once
#include <stdint.h>
struct RSTemporalFrame;
#ifdef __cplusplus
extern "C" {
#endif
enum RSGenerationCode {RS_GENERATION_OK=0,RS_GENERATION_INVALID=1,RS_GENERATION_BUSY=2,RS_GENERATION_FAILED=3};
struct RSGenerationOptions {
 uint32_t size,version;void*device;const char*shaderDirectory;
 // Reservations cover actual resources before allocation. The provider keeps
 // each returned lease until that resource and all GPU users retire.
 void*allocationContext;void*(*reserve)(void*,uint64_t);void(*release)(void*);
};
struct RSGenerationSubmission {
 uint32_t size,version;void*commandBuffer,*color;uint64_t sequence;
 uint32_t count,transferFunction;float minLuminance,maxLuminance;void*outputs[4];float phases[4];
 const struct RSTemporalFrame*scene;
};
struct RSGenerationResult {
 uint32_t size,version,status,encoded,ready,generated,historyFrames,reserved;
 uint64_t sequence;char reason[512];
};
struct RSGenerationProvider {
 uint32_t size,version;void*(*create)(const struct RSGenerationOptions*,struct RSGenerationResult*);
 int(*encode)(void*,const struct RSGenerationSubmission*,struct RSGenerationResult*);
 void(*destroy)(void*);
 // Metadata/resource preparation never records commands or advances history.
 int(*prepare)(void*,const struct RSGenerationSubmission*,struct RSGenerationResult*);
};
const struct RSGenerationProvider*rsGetGenerationProvider(uint32_t);
#ifdef __cplusplus
}
#endif
