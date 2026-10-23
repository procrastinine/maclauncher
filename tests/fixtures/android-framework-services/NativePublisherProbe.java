import java.nio.charset.StandardCharsets;
import maclauncher.android.framework.JvmNativeMemory;

public final class NativePublisherProbe {
    static final class Target {
        static int javaBoundary(){return 41;}
        static native int remaining();
        static native int nativeOverride();
        static native int overloaded(int value);
        static native int overloaded(String value);
        static int javaOverloaded(int value){return value+50;}
        static native int javaOverloaded(String value);
        static native int under_score();
        static native int initializations();
        static native void registerAgain();
    }
    static final class Guest {static native int call();}
    public static final class SystemTarget {
        public static int javaBoundary(){return 61;}
        public static native int nativeOverride();
        public static native int nativeRemaining();
        public static native int closureRemaining();
    }
    private static native void installGuestHooks();
    private static native void registerGuest();
    private static native int adaptations();
    private static native void registerSystem();
    private static native void registerApplication(Class<?> owner,boolean javaMethod);
    private static native void registerMissing();
    private static void verify(){
        if(Target.javaBoundary()!=41||Target.remaining()!=42||Target.nativeOverride()!=700||
            Target.overloaded(3)!=703||Target.overloaded("s")!=82||Target.javaOverloaded(4)!=54||
            Target.javaOverloaded("s")!=83||Target.under_score()!=704||Target.initializations()!=1)
            throw new AssertionError("Publisher/native/Java registration precedence differs");
    }
    public static void main(String[] args)throws Exception{
        System.load(args[0]);
        JvmNativeMemory.prepareRegistration(args[1].getBytes(StandardCharsets.UTF_8));
        System.load(args[1]);verify();
        installGuestHooks();Target.registerAgain();verify();
        registerGuest();if(Guest.call()!=77||adaptations()!=1)throw new AssertionError("Guest dispatcher chain changed");
        registerSystem();
        if(SystemTarget.javaBoundary()!=61||SystemTarget.nativeOverride()!=901||SystemTarget.nativeRemaining()!=77||
            SystemTarget.closureRemaining()!=78||adaptations()!=2)throw new AssertionError("System ELF/host-closure registration ownership differs");
        try {registerMissing();throw new AssertionError("Missing original method was ignored");}catch(NoSuchMethodError expected){}
        String name=SystemTarget.class.getName();
        byte[] bytes;
        try(var stream=NativePublisherProbe.class.getResourceAsStream("/"+name+".class")){bytes=stream.readAllBytes();}
        class ApplicationLoader extends ClassLoader {Class<?> define(){return defineClass(name,bytes,0,bytes.length);}}
        Class<?> application=new ApplicationLoader().define();
        registerApplication(application,false);
        if(!application.getMethod("nativeOverride").invoke(null).equals(78))throw new AssertionError("Framework symbol replaced application class method");
        try {registerApplication(application,true);throw new AssertionError("Application nonnative registration was ignored");}catch(NoSuchMethodError expected){}
        System.out.println("PASS publisher initializer, complete original/guest tables, exact Java/native overrides, overloads, translated closures and application loader isolation");
    }
}
