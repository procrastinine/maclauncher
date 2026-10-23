# Android native process startup

The Android JVM adapter configures native image startup before publishing an image. The invocation contains the authenticated Android process name as its first argument. Its environment contains the Android runtime values admitted by the launcher, including private home and temporary directories. Host JVM arguments and later host preload or diagnostic settings are excluded.

`NativeBinding.configureRuntime` obtains the invocation and environment from `HostContext`. The bridge encodes Java strings as standard UTF-8 and passes null-terminated vectors to `klj_library_set_startup`. The core owns the strings and vectors for the process lifetime. Matching repeat configuration is accepted; a changed invocation or environment is rejected. Constructors receive writable vectors, while repeat checks use separate copies of the original configuration.

For raw ARM64 ELF images, the core calls `DT_INIT` followed by `DT_INIT_ARRAY` entries as `void (int argc, char **argv, char **envp)`. Existing dependency order, once-only initialization and null or sentinel entries are preserved. Missing startup configuration fails initialization before constructor execution. Image-format providers retain their own initialization callback and calling convention.

The launcher transports environment entries through the versioned `KL_ANDROID_NATIVE_STARTUP_ENVIRONMENT` packet. Version 1 contains canonical unpadded base64url for a UTF-8 vector of NUL-terminated `key=value` entries. It accepts at most 64 distinct ASCII keys and 16,384 decoded bytes. Neither a missing packet nor invalid encoding falls back to the host environment.
