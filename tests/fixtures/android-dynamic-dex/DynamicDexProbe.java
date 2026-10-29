import dalvik.system.*;
import maclauncher.android.DynamicDex;
import maclauncher.android.framework.*;
import java.net.*;
import java.nio.*;
import java.nio.file.*;
import java.lang.reflect.InvocationTargetException;
import java.util.jar.*;

public final class DynamicDexProbe {
    static void check(boolean value,String detail){if(!value)throw new AssertionError(detail);}
    static int answer(ClassLoader loader)throws Exception{return (int)loader.loadClass("fixture.Value").getMethod("answer").invoke(null);}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),dex=Path.of(args[1]),parentJar=Path.of(args[2]),cache=Path.of(args[3]);
        Files.createDirectories(cache);
        HostFilesystem.configure(runtime,cache.getParent(),cache,cache,"owned.dex");
        System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
        System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());
        JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
        try(URLClassLoader parent=new URLClassLoader(new URL[]{parentJar.toUri().toURL()},DynamicDexProbe.class.getClassLoader())){
            DynamicDex.configure(runtime,cache,parentJar,parent);
            Path nativeRoot=Files.createDirectories(cache.resolve("native"));
            HostContext.hostPackage("owned.dex","1",1);HostContext.hostApplicationInfo(false,parentJar.toString(),cache.getParent().toString(),nativeRoot.toString(),35);
            maclauncher.android.bridge.GuestNativeLoader.configure(runtime.resolve("native/libklepton-jvm.dylib").toString(),nativeRoot.toString(),parentJar.toString(),parent);
            byte[] bytes=Files.readAllBytes(dex);ByteBuffer input=ByteBuffer.allocateDirect(bytes.length+8);input.position(4);input.put(bytes);input.flip();input.position(4);input.mark();
            var memory=new InMemoryDexClassLoader(input.asReadOnlyBuffer(),null);
            check(input.position()==4&&input.limit()==bytes.length+4,"buffer state");input.reset();
            check(answer(memory)==42,"real DEX result");check(memory.loadClass("fixture.Value").getClassLoader()==memory,"defining loader");
            check(memory.loadClass("android.content.Context")==android.content.Context.class,"Android boot API");
            var same=new InMemoryDexClassLoader(ByteBuffer.wrap(bytes),null);check(answer(same)==42,"cached bytes");
            check(HostDexFiles.headers(same).equals(HostDexFiles.headers(memory)),"same conversion cache entry");check(same.loadClass("fixture.Value")!=memory.loadClass("fixture.Value"),"separate loader identities");
            check(answer(new InMemoryDexClassLoader(new ByteBuffer[]{ByteBuffer.wrap(bytes),ByteBuffer.wrap(bytes)},null))==42,"ordered multidex");
            ByteBuffer[] manyInputs=new ByteBuffer[12];java.util.Arrays.setAll(manyInputs,index->ByteBuffer.wrap(bytes));
            check(answer(new InMemoryDexClassLoader(manyInputs,null))==42,"multidex remains usable above the former adapter quota");
            check(answer(new InMemoryDexClassLoader(ByteBuffer.wrap(Files.readAllBytes(Path.of(args[4]))),null))==42,"usable method remains available beside a JVM-oversized SDK method");
            check(answer(new DexClassLoader(dex.toString(),"ignored",null,parent))==7,"parent first");
            check(answer(new DelegateLastClassLoader(dex.toString(),parent))==42,"delegate last");
            Path archive=cache.resolve("module.jar");try(JarOutputStream zip=new JarOutputStream(Files.newOutputStream(archive))){zip.putNextEntry(new JarEntry("classes.dex"));zip.write(bytes);zip.closeEntry();zip.putNextEntry(new JarEntry("asset.txt"));zip.write(new byte[]{42});zip.closeEntry();}
            var path=new PathClassLoader(archive.toString(),null);check(answer(path)==42,"archive DEX");try(var stream=path.getResourceAsStream("asset.txt")){check(stream!=null&&stream.read()==42,"original resource");}
            try{memory.loadClass("fixture.Value").getMethod("nativeLoad").invoke(null);throw new AssertionError("missing native library accepted");}catch(InvocationTargetException expected){check(expected.getCause() instanceof UnsatisfiedLinkError&&expected.getCause().getMessage().contains("libnever.so"),"actual missing native library diagnostic");}
            var paths=new DexClassLoader("",null,cache.toString(),parent);paths.addDexPath(dex.toString());check(answer(paths)==7,"original addDexPath and parent delegation");
            check(paths.findLibrary("absent")==null,"native library lookup preserves normal absence");
            byte[] damaged=bytes.clone();damaged[damaged.length-1]^=1;
            try{new InMemoryDexClassLoader(ByteBuffer.wrap(damaged),null).loadClass("fixture.Value");throw new AssertionError("damaged DEX accepted");}catch(ClassNotFoundException expected){check(expected.getSuppressed().length>0,"original suppressed converter diagnostic");}
            try(var files=Files.walk(cache)){check(files.noneMatch(p->p.getFileName().toString().startsWith("convert-")),"partial files retired");}
            DynamicDex.hostShutdown();check(answer(memory)==42,"existing classes remain valid during shutdown");
            try{new InMemoryDexClassLoader(ByteBuffer.wrap(bytes),null).loadClass("fixture.Value");throw new AssertionError("closed host accepted conversion");}catch(ClassNotFoundException closed){check(closed.getSuppressed().length>0,"closed session diagnostic retained");}
        }
        System.out.println("PASS real DEX conversion, defining loaders, delegation, resources, cache, errors and shutdown");
    }
}
