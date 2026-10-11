# BGI immediate bitmap compositor

This developer source version adds a finite Ethornell 1.72 graphics service `0x9043` contract on top of `0.0.1-build734-mac-vm-v4`. The service consumes nine words and has no completion value on the operand stack: source viewport X/Y, bitmap slot, second viewport X/Y, second-image selector, mask slot, mask parameter and transparency.

The supported selectors are `0x7fff` and `0xffffffff`, with mask slot `0xffffffff` and transparency `0`. This draws the current source bitmap into the scene, clips the source viewport and fills uncovered areas with black. Color32 sources ignore their alpha byte; alpha32 sources use the native seven-bit alpha conversion. The second viewport and mask parameter do not affect this branch. A subsequent request updates the same immediate draw object. Bitmap edits affect rendering; releasing or replacing the bitmap invalidates its draw reference and clears its canvas to black until another request selects a bitmap. Source replacement does not allocate another draw object or copy its pixels.

Second-image composition, mask composition, other selectors and nonzero transparency fail explicitly. Not yet supported for play. This source version is excluded from app packaging.
