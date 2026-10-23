# Android JVM native method lookup

Android application libraries retain their defining class loader and loaded image. JNI short and long symbol names are resolved against that image. File symbol tables provide dependency metadata and early class-definition hints; loaded symbol tables determine which native methods are available.

Library preparation takes one inventory of prepared native classes belonging to the defining loader. Later class preparation extends that inventory through a JVMTI ClassPrepare observer. Export lookup does not initialize application classes or prepare unrelated classes. Native method inventories are cached by class, while unavailable symbols can be reconsidered after a relevant library or class transition.

Committed RegisterNatives entries retain precedence over exported-symbol registration, including methods declared in a superclass and a committed prefix followed by a later registration error. The JVM's NativeMethodBind event supplies the actual method and declaring class while registration executes, including registration on an unprepared class. UnregisterNatives removes ownership for the methods declared by the specified class, allowing later library loading to resolve those methods again. The registration owner uses weak declaring-class references and serializes registration updates with exported-method publication. Native invocation remains a direct registered call.

The prepared loading entry publishes the image to its Java owner before ELF constructors execute. Earlier entry classes retain their load-without-initialization, publication, then-construction sequence. JNI_OnLoad follows construction and runs once for its owning library and class loader. Missing symbols retain the JVM's UnsatisfiedLinkError behavior.
