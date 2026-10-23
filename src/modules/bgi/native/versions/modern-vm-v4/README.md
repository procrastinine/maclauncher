# BGI bitmap format service

This developer source version adds Ethornell 1.72 graphics service `0x9017` to the finite native VM contracts. It builds on `0.0.1-build734-mac-vm-v3` and verifies the exact parent source hashes before staging changes.

The service consumes a bitmap slot followed by a requested runtime pixel format. It pushes status `0` for success, `1` for an absent or out-of-range slot, or `2` for a conversion outside the declared pixel-format pair. An unchanged format succeeds. The supported conversion is `alpha32` (`2`) to `color32` (`1`): pixel bytes and allocations remain intact, while subsequent rendering uses color32 semantics. Color32 and alpha32 both occupy four bytes per pixel. Other conversions leave the bitmap unchanged.

This source version is excluded from app packaging.
