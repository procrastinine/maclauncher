`classes.dex` is the D8 conversion of the included `app/Calls.java`, compiled
against `api/Callback.java` with Java 8 bytecode and D8 minimum API 26. The
callback stays in a separate hierarchy JAR. The test executes the converted
interface default call with JVM verification enabled. No app or runtime source
is included in this fixture.
