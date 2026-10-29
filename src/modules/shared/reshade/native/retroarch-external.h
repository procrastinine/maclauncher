#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <stdint.h>
#include <stddef.h>
// Additive optional C API beside the unchanged original librashader API.
// Names are authored identifiers. Image and matrix inputs are read-only.
typedef struct LibraMTLExternalDeclarationV1 {
    const char *name;
    uint32_t kind, reserved;
} LibraMTLExternalDeclarationV1;
typedef struct LibraMTLExternalValueV1 {
    const char *name;
    uint32_t kind, reserved;
    const void *texture;
    // Column-major GLSL values. The provider honors reflected storage order.
    float matrix[16];
} LibraMTLExternalValueV1;
