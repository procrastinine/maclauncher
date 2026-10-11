# BGI current draw initialization

This developer source version extends `0.0.1-build734-mac-vm-v6` with the Ethornell 1.72 renderer's initial current object. The renderer starts with a type-1 object, no bitmap content and an independent registration sequence. Its draw wrapper fills the canvas black. Graphic handle `0` addresses this current object; either offset service changes its own offsets without moving other objects.

Selecting the supported plain bitmap draw through `0x9043` replaces the initial object with type 4, resets its offsets and assigns a new sequence. Repeated requests for the same draw type retain its offsets and sequence. Bitmap source pixels stay live; replacement or release invalidates the reference and restores the black fallback.

Type-1 bitmap content, other current draw types, second images, masks and nonzero transparency remain unsupported and fail explicitly. Not yet supported for play. This source version is excluded from app packaging.
