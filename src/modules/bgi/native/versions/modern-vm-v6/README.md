# BGI secondary graphic offsets

This developer source version adds Ethornell 1.72 graphics service `0x9036` to `0.0.1-build734-mac-vm-v5`. It consumes an existing graphic handle and signed X/Y offsets, with no completion value on the operand stack. The offsets remain independent of an object's position and first offset. Rendering adds both offsets with native 32-bit coordinate wrapping.

Sprite, filter, window and group handles retain their own namespaces. Group updates propagate to existing children. Handle `0` addresses the current immediate bitmap draw object for either offset service (`0x9036` or `0x9037`); a supported current object is required. Other objects remain unchanged by either current-object update. Repeated immediate bitmap requests retain both offsets; bitmap replacement invalidates the source reference.

Current-object offset support covers the plain bitmap draw selected by `0x9043`. The renderer's initial type-1 current object and other immediate draw types remain unsupported. Handle `0` fails explicitly until a supported current draw exists.

Invalid handles, cyclic child graphs and invalid child references fail before changing offsets. Not yet supported for play. This source version is excluded from app packaging.
