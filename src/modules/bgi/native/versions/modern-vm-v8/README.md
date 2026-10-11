# BGI two-image bitmap compositing

This developer source version extends `0.0.1-build734-mac-vm-v7` with the no-mask two-image branch of Ethornell 1.72 service `0x9043`. Both source viewports use the current object's independent offsets and native 32-bit coordinate wrapping. Each viewport clips to the canvas. Pixels outside both viewports retain the existing canvas.

The compositor first copies the second image with pixel-format conversion, then blends the primary image with transparency from 0 through 256. Zero selects the primary image; 256 leaves the second image. Color32 ignores stored alpha. Alpha32 uses the native seven-bit coverage and integer rounding rules, including the different terminal coverage behavior at zero transparency.

Both source pixels stay live, and both captured bitmap identities must remain valid even at the transparency endpoints. Replacing or releasing either source restores the native black fallback until a new valid request. Repeated requests retain the current type's offsets and registration sequence.

Masks, special effect selectors, nonzero transparency without a second image, type-1 bitmap content and other immediate draw types remain unsupported and fail explicitly. Native playback remains incomplete; this source version stays excluded from app packaging.
