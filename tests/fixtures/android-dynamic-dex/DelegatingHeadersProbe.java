import maclauncher.android.DynamicDex;
import java.net.*;
import java.nio.*;
import java.nio.file.*;
import java.io.*;
import java.util.concurrent.*;

public final class DelegatingHeadersProbe {
    static void check(boolean pass,String detail){if(!pass)throw new AssertionError(detail);}
    static final class Delegate extends ClassLoader {
        volatile ClassLoader target;
        Delegate(ClassLoader target){super(DelegatingHeadersProbe.class.getClassLoader());this.target=target;}
        @Override protected synchronized Class<?> loadClass(String name,boolean resolve)throws ClassNotFoundException{
            return name.startsWith("fixture.headers.")?target.loadClass(name):super.loadClass(name,resolve);
        }
    }
    static final class PausedParent extends ClassLoader {
        final CountDownLatch entered,release;
        PausedParent(ClassLoader parent,CountDownLatch entered,CountDownLatch release){super(parent);this.entered=entered;this.release=release;}
        @Override protected synchronized Class<?> loadClass(String name,boolean resolve)throws ClassNotFoundException{
            if(name.equals("fixture.headers.HeaderLeft")){
                entered.countDown();
                try{release.await();}catch(InterruptedException failure){Thread.currentThread().interrupt();throw new ClassNotFoundException(name,failure);}
            }
            return super.loadClass(name,resolve);
        }
    }
    static DynamicDex.Module converted(byte[] dex,ClassLoader parent)throws Exception{
        var module=DynamicDex.buffers(new ByteBuffer[]{ByteBuffer.wrap(dex)},parent);
        // Demand conversion does no parent lookup until a real class request.
        if(Boolean.getBoolean("maclauncher.dex.demand"))module.classBytes("fixture.headers.Choice");
        return module;
    }
    static void independent(byte[] dex,ClassLoader knownParent,ClassLoader directParent)throws Exception{
        CountDownLatch entered=new CountDownLatch(2),release=new CountDownLatch(1);
        ExecutorService workers=Executors.newFixedThreadPool(3);
        try{
            var one=workers.submit(()->converted(dex,new PausedParent(directParent,entered,release)));
            var two=workers.submit(()->converted(dex,new PausedParent(directParent,entered,release)));
            check(entered.await(10,TimeUnit.SECONDS),"independent conversions and parent lookups do not serialize behind another loader");
            var cached=workers.submit(()->DynamicDex.buffers(new ByteBuffer[]{ByteBuffer.wrap(dex)},knownParent));
            cached.get(3,TimeUnit.SECONDS).run();
            release.countDown();
            DynamicDex.Module a=one.get(10,TimeUnit.SECONDS),b=two.get(10,TimeUnit.SECONDS);
            check(a.headers().equals(b.headers()),"concurrent equivalent conversions publish one immutable artifact");
            invoke(choice(a,directParent),directParent);a.run();b.run();
        }finally{release.countDown();workers.shutdownNow();check(workers.awaitTermination(10,TimeUnit.SECONDS),"converter callers retire");}
    }
    static void cancelTogether(byte[] dex,ClassLoader parent)throws Exception{
        CountDownLatch entered=new CountDownLatch(2),release=new CountDownLatch(1);
        var existing=ProcessHandle.current().children().map(ProcessHandle::pid).collect(java.util.stream.Collectors.toSet());
        ExecutorService workers=Executors.newFixedThreadPool(2);
        try{
            var one=workers.submit(()->converted(dex,new PausedParent(parent,entered,release)));
            var two=workers.submit(()->converted(dex,new PausedParent(parent,entered,release)));
            check(entered.await(10,TimeUnit.SECONDS),"both converter processes reach parent resolution");
            var children=ProcessHandle.current().children().filter(child->!existing.contains(child.pid())&&child.info().commandLine().orElse("").contains("DexConvert")).toList();
            check(children.size()==2,"both converters remain owned while callbacks are paused");
            DynamicDex.hostShutdown();
            check(children.stream().noneMatch(ProcessHandle::isAlive),"shutdown cancels every active converter");
            release.countDown();
            for(var pending:java.util.List.of(one,two))try{pending.get(10,TimeUnit.SECONDS);throw new AssertionError("closed conversion published output");}
                catch(ExecutionException expected){check(expected.getCause() instanceof IllegalArgumentException||expected.getCause() instanceof IOException,"original conversion cancellation reaches caller");}
        }finally{release.countDown();workers.shutdownNow();check(workers.awaitTermination(10,TimeUnit.SECONDS),"cancelled callers retire");}
    }
    static Class<?> choice(DynamicDex.Module module,ClassLoader parent)throws Exception{
        return new ClassLoader(parent){
            @Override protected Class<?> findClass(String name)throws ClassNotFoundException{
                try{byte[] bytes=module.classBytes(name);if(bytes==null)throw new ClassNotFoundException(name);return defineClass(name,bytes,0,bytes.length);}
                catch(IOException e){throw new ClassNotFoundException(name,e);}
            }
        }.loadClass("fixture.headers.Choice");
    }
    static void invoke(Class<?> choice,ClassLoader parent)throws Exception{
        Class<?> left=parent.loadClass("fixture.headers.HeaderLeft"),right=parent.loadClass("fixture.headers.HeaderRight");
        Object a=left.getConstructor().newInstance(),b=right.getConstructor().newInstance();
        var select=choice.getMethod("choose",boolean.class,left,right);
        check(select.invoke(null,true,a,b)==a&&select.invoke(null,false,a,b)==b,"converted merge preserves both branches");
    }
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),cache=Files.createDirectories(Path.of(args[1]));
        try(var first=new URLClassLoader(new URL[]{Path.of(args[3]).toUri().toURL()},DelegatingHeadersProbe.class.getClassLoader());
            var second=new URLClassLoader(new URL[]{Path.of(args[4]).toUri().toURL()},DelegatingHeadersProbe.class.getClassLoader())){
            DynamicDex.configure(runtime,cache,Path.of(args[3]),first);
            byte[] dex=Files.readAllBytes(Path.of(args[2]));Delegate wrapper=new Delegate(first);
            // Holding the loader monitor catches a metadata worker deadlock.
            DynamicDex.Module original; synchronized(wrapper){original=converted(dex,wrapper);}
            check(System.getProperty("fixture.headers.initialized")==null,"parent headers do not initialize guest classes");
            DynamicDex.Module repeated=DynamicDex.buffers(new ByteBuffer[]{ByteBuffer.wrap(dex)},wrapper);
            check(original.headers().equals(repeated.headers()),"same resolved hierarchy reuses cache");
            independent(dex,wrapper,first);
            invoke(choice(original,wrapper),wrapper);
            // The same wrapper may change delegation during its lifetime.
            // Only the exact immutable platform parent may memoize lookups.
            wrapper.target=second;
            DynamicDex.Module changed=DynamicDex.buffers(new ByteBuffer[]{ByteBuffer.wrap(dex)},wrapper);
            if(!Boolean.getBoolean("maclauncher.dex.demand"))check(!original.headers().equals(changed.headers()),"changed delegate hierarchy invalidates cache");
            check(Files.isRegularFile(original.headers().getFirst()),"probing another cached hierarchy must retain a live loader's header archive");
            invoke(choice(changed,wrapper),wrapper);
            // A plain ClassLoader with normal parent delegation also works.
            ClassLoader nested=new ClassLoader(first){};
            DynamicDex.Module inherited=DynamicDex.buffers(new ByteBuffer[]{ByteBuffer.wrap(dex)},nested);
            invoke(choice(inherited,nested),nested);
            try(var cancellationParent=new URLClassLoader(new URL[]{Path.of(args[3]).toUri().toURL(),Path.of(args[4]).toUri().toURL()},DelegatingHeadersProbe.class.getClassLoader())){
                cancelTogether(dex,cancellationParent);
            }
            original.run();repeated.run();changed.run();inherited.run();
        }finally{DynamicDex.hostShutdown();}
        System.out.println("PASS delegated parent headers, verified sibling merge, no initialization, cache invalidation, independent concurrent conversion and loader monitor");
    }
}
