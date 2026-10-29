#pragma once
#include "temporal-frame.h"
namespace macfx {
struct ImageColorDescription;
// Packaged ABI1 providers with a prepared linear BT.709/203-nit boundary.
// The returned method identifier is also the ordinary ordered-row identifier.
const char* linearABI1TemporalMethod(uint32_t)noexcept;
// Owned SDK providers must not re-enter the application capture hook.
class InternalTemporalScope {bool previous;public:InternalTemporalScope()noexcept;~InternalTemporalScope();};
// Ordered rows call the provider dispatcher directly to avoid entering the
// renderer's scene graph boundary a second time.
int encodeTemporalProvider(const RSTemporalFrame*,RSTemporalResult*);
int encodeTemporalProvider(const RSTemporalFrame*,RSTemporalResult*,const ImageColorDescription&);
// False means a loaded older provider lacks the resource-only hook. Otherwise
// preparation was attempted and the caller must inspect the result status.
bool prepareTemporalProvider(const RSTemporalFrame*,RSTemporalResult*);
bool prepareTemporalProvider(const RSTemporalFrame*,RSTemporalResult*,const ImageColorDescription&);
}
