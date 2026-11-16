#pragma once
#include "generation-provider.h"
// Private extension used only by the ANR adapter and its matched provider.
struct RSANRSubmission {
 RSGenerationSubmission base;
 void*ui;uint32_t bottomLeft,premultiplied;
 float referenceWhite;
};

struct RSANROptions {RSGenerationOptions base;const char*runtimeRoot;};
