# Android native image metadata

The native loader retains each image's mapped program-header pointer and its
validated header count during loading. Later changes to the ELF header do not
remove the image from program-header enumeration. The mapped program-header
array remains live, so changes to its contents remain visible to consumers.

The retained pointer belongs to the image mapping and remains valid until the
image unloads. Enumeration and process-map formatting use the same image base,
extent and namespace ownership. Native format providers retain their own
program-header callbacks and mapping lifetimes.

This metadata follows Android's linker model, where a loaded image stores its
program-header pointer and count independently of the ELF header's later bytes.
