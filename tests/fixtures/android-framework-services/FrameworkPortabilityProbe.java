import maclauncher.android.portability.PortableCalls;
import java.lang.reflect.*;
import java.util.*;
import org.objectweb.asm.*;

/** Exact callsite transforms preserve native boundaries and ordinary JVM errors. */
public final class FrameworkPortabilityProbe {
    static void check(boolean value){if(!value)throw new AssertionError();}
    static byte[] fixture(){
        ClassWriter out=new ClassWriter(0);out.visit(Opcodes.V17,Opcodes.ACC_PUBLIC,"PortableFixture",null,"java/lang/Object",null);
        out.visitMethod(Opcodes.ACC_PUBLIC|Opcodes.ACC_STATIC|Opcodes.ACC_NATIVE,"untouchedNative","()J",null,null).visitEnd();
        var copy=out.visitMethod(Opcodes.ACC_PUBLIC|Opcodes.ACC_STATIC,"copy","([BI[BII)V",null,null);copy.visitCode();
        copy.visitVarInsn(Opcodes.ALOAD,0);copy.visitVarInsn(Opcodes.ILOAD,1);copy.visitVarInsn(Opcodes.ALOAD,2);copy.visitVarInsn(Opcodes.ILOAD,3);copy.visitVarInsn(Opcodes.ILOAD,4);
        copy.visitMethodInsn(Opcodes.INVOKESTATIC,"java/lang/System","arraycopy","([BI[BII)V",false);copy.visitInsn(Opcodes.RETURN);copy.visitMaxs(5,5);copy.visitEnd();
        var first=out.visitMethod(Opcodes.ACC_PUBLIC|Opcodes.ACC_STATIC,"first","(Ljava/util/LinkedHashMap;)Ljava/util/Map$Entry;",null,null);first.visitCode();first.visitVarInsn(Opcodes.ALOAD,0);first.visitMethodInsn(Opcodes.INVOKEVIRTUAL,"java/util/LinkedHashMap","eldest","()Ljava/util/Map$Entry;",false);first.visitInsn(Opcodes.ARETURN);first.visitMaxs(1,1);first.visitEnd();out.visitEnd();return out.toByteArray();
    }
    static byte[] cleanerFixture(){
        ClassWriter out=new ClassWriter(0);out.visit(Opcodes.V17,Opcodes.ACC_PUBLIC,"LegacyCleanerFixture",null,"java/lang/Object",null);
        out.visitField(Opcodes.ACC_PUBLIC,"field","Lsun/misc/Cleaner;",null,null).visitEnd();
        var create=out.visitMethod(Opcodes.ACC_PUBLIC|Opcodes.ACC_STATIC,"create","(Ljava/lang/Object;Ljava/lang/Runnable;)Lsun/misc/Cleaner;",null,null);create.visitCode();create.visitVarInsn(Opcodes.ALOAD,0);create.visitVarInsn(Opcodes.ALOAD,1);create.visitMethodInsn(Opcodes.INVOKESTATIC,"sun/misc/Cleaner","create","(Ljava/lang/Object;Ljava/lang/Runnable;)Lsun/misc/Cleaner;",false);create.visitInsn(Opcodes.ARETURN);create.visitMaxs(2,2);create.visitEnd();
        var clean=out.visitMethod(Opcodes.ACC_PUBLIC|Opcodes.ACC_STATIC,"clean","(Lsun/misc/Cleaner;)V",null,null);clean.visitCode();clean.visitVarInsn(Opcodes.ALOAD,0);clean.visitMethodInsn(Opcodes.INVOKEVIRTUAL,"sun/misc/Cleaner","clean","()V",false);clean.visitInsn(Opcodes.RETURN);clean.visitMaxs(1,1);clean.visitEnd();out.visitEnd();return out.toByteArray();
    }
    static java.lang.ref.WeakReference<Object> gcRegistration(java.util.concurrent.CountDownLatch done){
        Object owner=new Object();var weak=new java.lang.ref.WeakReference<>(owner);
        maclauncher.android.framework.JvmCleaner.create(owner,done::countDown);return weak;
    }
    static void cleaner()throws Exception{
        byte[] normalized=new PortableCalls().normalize(cleanerFixture());
        Class<?> type=new ClassLoader(){Class<?> load(){return defineClass("LegacyCleanerFixture",normalized,0,normalized.length);}}.load();
        Class<?> cleaner=maclauncher.android.framework.JvmCleaner.class;check(type.getField("field").getType()==cleaner);
        var owner=new Object();var calls=new java.util.concurrent.atomic.AtomicInteger();Object registration=type.getMethod("create",Object.class,Runnable.class).invoke(null,owner,(Runnable)calls::incrementAndGet);
        var clean=type.getMethod("clean",cleaner);var workers=new ArrayList<Thread>();for(int n=0;n<12;n++){Thread thread=new Thread(()->{try{for(int i=0;i<500;i++)clean.invoke(null,registration);}catch(Exception e){throw new AssertionError(e);}});workers.add(thread);thread.start();}for(var thread:workers)thread.join();check(calls.get()==1);java.lang.ref.Reference.reachabilityFence(owner);
        check(maclauncher.android.framework.JvmCleaner.create(new Object(),null)==null);
        var explicitNull=maclauncher.android.framework.JvmCleaner.create(null,calls::incrementAndGet);explicitNull.clean();explicitNull.clean();check(calls.get()==2);
        var error=new IllegalStateException("cleanup failure");var failing=maclauncher.android.framework.JvmCleaner.create(owner,()->{calls.incrementAndGet();throw error;});try{failing.clean();throw new AssertionError();}catch(IllegalStateException actual){check(actual==error);}failing.clean();check(calls.get()==3);
        var collected=new java.util.concurrent.CountDownLatch(1);var weak=gcRegistration(collected);long limit=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(8);
        while(collected.getCount()!=0&&System.nanoTime()<limit){System.gc();collected.await(20,java.util.concurrent.TimeUnit.MILLISECONDS);}check(collected.getCount()==0&&weak.get()==null);
        byte[] registry;try(var input=ClassLoader.getSystemResourceAsStream("libcore/util/NativeAllocationRegistry.class")){check(input!=null);registry=input.readAllBytes();}
        byte[] adapted=new PortableCalls().normalize(registry);check(Arrays.equals(adapted,new PortableCalls().normalize(adapted)));
        int[] found={0,0,0};new ClassReader(adapted).accept(new ClassVisitor(Opcodes.ASM9){@Override public MethodVisitor visitMethod(int access,String name,String descriptor,String signature,String[] exceptions){
            if(name.equals("applyFreeFunction")){check((access&Opcodes.ACC_NATIVE)!=0&&descriptor.equals("(JJ)V"));found[0]++;}
            return new MethodVisitor(Opcodes.ASM9){@Override public void visitMethodInsn(int opcode,String owner,String method,String desc,boolean iface){if(owner.equals(PortableCalls.MEMORY)&&method.equals("initialize"))found[1]++;if(owner.equals(PortableCalls.MEMORY)&&method.equals("registerAllocation"))found[2]++;}};
        }},0);check(Arrays.equals(found,new int[]{1,1,1}));
    }
    static void pixelCopyNativeRegistration(){
        ClassWriter source=new ClassWriter(0);String owner="android/graphics/HardwareRenderer";
        String signature="(Landroid/view/Surface;IIIILandroid/graphics/HardwareRenderer$CopyRequest;)V";
        source.visit(Opcodes.V17,Opcodes.ACC_PUBLIC,owner,null,"java/lang/Object",null);
        source.visitMethod(Opcodes.ACC_PRIVATE|Opcodes.ACC_STATIC|Opcodes.ACC_NATIVE,"nCopySurfaceInto",signature,null,null).visitEnd();
        var caller=source.visitMethod(Opcodes.ACC_PUBLIC|Opcodes.ACC_STATIC,"copySurfaceInto",signature,null,null);caller.visitCode();
        caller.visitVarInsn(Opcodes.ALOAD,0);for(int i=1;i<=4;i++)caller.visitVarInsn(Opcodes.ILOAD,i);caller.visitVarInsn(Opcodes.ALOAD,5);
        caller.visitMethodInsn(Opcodes.INVOKESTATIC,owner,"nCopySurfaceInto",signature,false);caller.visitInsn(Opcodes.RETURN);caller.visitMaxs(6,6);caller.visitEnd();source.visitEnd();
        byte[] original=source.toByteArray();
        int[] found={0,0};byte[] normalized=GraphicsPortability.transform(owner+".class",original);
        check(Arrays.equals(original,normalized));
        new ClassReader(normalized).accept(new ClassVisitor(Opcodes.ASM9){@Override public MethodVisitor visitMethod(int access,String name,String descriptor,String generic,String[] errors){
            if(name.equals("nCopySurfaceInto")){check((access&Opcodes.ACC_NATIVE)!=0&&descriptor.equals(signature));found[0]++;}
            return new MethodVisitor(Opcodes.ASM9){@Override public void visitMethodInsn(int opcode,String destination,String name,String descriptor,boolean iface){if(name.equals("nCopySurfaceInto")){check(destination.equals(owner)&&descriptor.equals(signature));found[1]++;}}};
        }},0);check(Arrays.equals(found,new int[]{1,1}));
    }
    public static void main(String[] args)throws Exception{
        cleaner();pixelCopyNativeRegistration();
        PortableCalls transform=new PortableCalls();byte[] original=fixture(),normalized=transform.normalize(original);
        Class<?> type=new ClassLoader(){Class<?> load(){return defineClass("PortableFixture",normalized,0,normalized.length);}}.load();
        byte[] bytes={1,2,3,4};Method copy=type.getMethod("copy",byte[].class,int.class,byte[].class,int.class,int.class);
        copy.invoke(null,bytes,0,bytes,1,3);check(Arrays.equals(bytes,new byte[]{1,1,2,3}));
        try{copy.invoke(null,bytes,-1,bytes,0,1);throw new AssertionError();}catch(InvocationTargetException error){check(error.getCause() instanceof IndexOutOfBoundsException);}
        var map=new LinkedHashMap<String,Integer>();Method first=type.getMethod("first",LinkedHashMap.class);check(first.invoke(null,map)==null);map.put("a",1);map.put("b",2);check(((Map.Entry<?,?>)first.invoke(null,map)).getKey().equals("a"));
        check(Modifier.isNative(type.getMethod("untouchedNative").getModifiers()));
        check(Arrays.equals(normalized,new PortableCalls().normalize(normalized)));
        var helper=maclauncher.android.framework.JvmPortability.class;
        check(((int[])maclauncher.android.framework.JvmPortability.newUnpaddedArray(new Object(),int.class,7)).length==7);
        try{maclauncher.android.framework.JvmPortability.newUnpaddedArray(new Object(),int.class,-1);throw new AssertionError();}catch(NegativeArraySizeException expected){}
        try{maclauncher.android.framework.JvmPortability.newUnpaddedArray(null,int.class,1);throw new AssertionError();}catch(NullPointerException expected){}
        check(maclauncher.android.framework.JvmPortability.adjustLanguageCode("he").equals("iw"));
        // Historical libcore compares aliases before case normalization; preserve it.
        check(maclauncher.android.framework.JvmPortability.adjustLanguageCode("HE").equals("he"));
        var captured=new java.io.ByteArrayOutputStream();var previous=System.err;
        try{System.setErr(new java.io.PrintStream(captured,true,java.nio.charset.StandardCharsets.UTF_8));
            maclauncher.android.framework.JvmPortability.logE("bounded",new Throwable(){@Override public void printStackTrace(java.io.PrintWriter writer){writer.print("x".repeat(65536));}});
        }finally{System.setErr(previous);}
        check(captured.size()<=32768);check(captured.toString(java.nio.charset.StandardCharsets.UTF_8).endsWith("[diagnostic truncated]\n"));
        System.out.println("PASS portable AOSP calls, unchanged native declarations and JVM error semantics");
    }
}
