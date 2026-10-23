package android.app;
import maclauncher.android.framework.HostActivityManager;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import javax.microedition.khronos.egl.*;

public final class GraphicsCapabilityProbe {
    private static EGLConfig config(long value)throws Exception{var constructor=com.google.android.gles_jni.EGLConfigImpl.class.getDeclaredConstructor(long.class);constructor.setAccessible(true);return constructor.newInstance(value);}
    private static void check(boolean value){if(!value)throw new AssertionError();}
    private static final class Model {
        boolean es3=true,es2=true,initialize=true,terminate=true;String fail;long current;int minor;
        final java.util.Map<EGLContext,int[]> contexts=new java.util.IdentityHashMap<>();
        final ArrayList<String> calls=new ArrayList<>();
        EGL10 api(){return (EGL10)Proxy.newProxyInstance(getClass().getClassLoader(),new Class<?>[]{EGL10.class},(p,m,args)->{
            String name=m.getName();calls.add(name);if(name.equals(fail))throw new IllegalArgumentException(name);
            return switch(name){
                case "eglGetCurrentContext" -> new com.google.android.gles_jni.EGLContextImpl(current);
                case "eglGetDisplay" -> new com.google.android.gles_jni.EGLDisplayImpl(11);
                case "eglInitialize" -> initialize;
                case "eglTerminate" -> terminate;
                case "eglChooseConfig" -> {int[] attributes=(int[])args[1];check(attributes.length==5&&attributes[0]==0x3033&&attributes[1]==1&&attributes[2]==0x3040&&attributes[4]==0x3038);int bit=attributes[3];check(bit==4||bit==0x40);int count=(bit==4?es2:es3)?1:0;((int[])args[4])[0]=count;if(count!=0)((EGLConfig[])args[2])[0]=config(bit);yield true;}
                case "eglGetConfigAttrib" -> {check((int)args[2]==0x3040);((int[])args[3])[0]=es3?0x44:4;yield true;}
                case "eglCreateContext" -> {int[] attributes=(int[])args[3];int major=attributes[1],requestedMinor=attributes[3];if(major==3&&requestedMinor>minor)yield EGL10.EGL_NO_CONTEXT;var context=new com.google.android.gles_jni.EGLContextImpl(100+major*10+requestedMinor);contexts.put(context,new int[]{major,requestedMinor});yield context;}
                case "eglGetError" -> 0x3009;
                case "eglQueryContext" -> {((int[])args[3])[0]=contexts.get((EGLContext)args[1])[(int)args[2]==0x3098?0:1];yield true;}
                case "eglDestroyContext" -> contexts.remove((EGLContext)args[1])!=null;
                default -> throw new AssertionError("Unexpected EGL operation "+name);
            };
        });}
    }
    private static Throwable failure(Model m){try{HostActivityManager.queryGraphics(m.api());throw new AssertionError("Expected query error");}catch(IllegalStateException|IllegalArgumentException error){return error;}}
    private static void independentProcessQueries()throws Exception{
        Object lock=HostActivityManager.class;
        try{var field=HostActivityManager.class.getDeclaredField("graphicsLock");field.setAccessible(true);lock=field.get(null);}catch(NoSuchFieldException original){}
        var entered=new java.util.concurrent.CountDownLatch(1);var release=new java.util.concurrent.CountDownLatch(1);
        final Object owner=lock;
        Thread graphics=new Thread(()->{synchronized(owner){entered.countDown();try{release.await();}catch(InterruptedException failure){throw new AssertionError(failure);}}});
        graphics.start();check(entered.await(5,java.util.concurrent.TimeUnit.SECONDS));
        var completed=new java.util.concurrent.CompletableFuture<Void>();
        Thread queries=new Thread(()->{try{
            var state=new ActivityManager.RunningAppProcessInfo();HostActivityManager.getMyMemoryState(state);
            check(state.pid==android.os.Process.myPid());
            check(!HostActivityManager.hostHasSystemFeature(android.content.pm.PackageManager.FEATURE_WATCH,0));
            check(HostActivityManager.hostHasSystemFeature(android.content.pm.PackageManager.FEATURE_TOUCHSCREEN,0));
            for(String name:new String[]{android.content.pm.PackageManager.FEATURE_FAKETOUCH,
                android.content.pm.PackageManager.FEATURE_AUDIO_OUTPUT,
                android.content.pm.PackageManager.FEATURE_SCREEN_LANDSCAPE,
                android.content.pm.PackageManager.FEATURE_SCREEN_PORTRAIT}){
                check(HostActivityManager.hostHasSystemFeature(name,0));
                check(!HostActivityManager.hostHasSystemFeature(name,1));
            }
            check(HostActivityManager.hostHasSystemFeature(android.content.pm.PackageManager.FEATURE_RAM_LOW,0)==ActivityManager.isLowRamDeviceStatic());
            check(HostActivityManager.hostHasSystemFeature(android.content.pm.PackageManager.FEATURE_RAM_NORMAL,0)!=ActivityManager.isLowRamDeviceStatic());
            check(!HostActivityManager.hostHasSystemFeature(android.content.pm.PackageManager.FEATURE_CAMERA,0));
            check(!HostActivityManager.hostHasSystemFeature(android.content.pm.PackageManager.FEATURE_MICROPHONE,0));
            var field=HostActivityManager.class.getDeclaredField("graphicsQueried");field.setAccessible(true);check(!field.getBoolean(null));
            completed.complete(null);
        }catch(Throwable failure){completed.completeExceptionally(failure);}});
        queries.start();
        try{completed.get(2,java.util.concurrent.TimeUnit.SECONDS);}
        finally{release.countDown();graphics.join(5000);queries.join(5000);}
        check(!graphics.isAlive()&&!queries.isAlive());
    }
    public static void main(String[] args)throws Exception{
        maclauncher.android.fixture.RuntimeFixture.initialize(args[0],args[1]);
        independentProcessQueries();
        if(args.length>2)System.load(args[2]);
        System.load(System.getProperty("klepton.graphics"));
        maclauncher.android.bridge.Graphics.configureHost(null,java.nio.file.Path.of(args[0],"native/angle").toAbsolutePath().toString(),16,16);
        maclauncher.android.bridge.NativeSurface.configureGraphics(System.getProperty("klepton.graphics"));
        var framework=java.nio.file.Path.of(args[0],"android-framework.jar");
        maclauncher.android.framework.FrameworkResources.configure(framework,java.util.List.of(framework));
        maclauncher.android.framework.HostContext.hostApplicationInfo(0,framework.toString(),args[1],java.nio.file.Path.of(args[0],"native").toString(),0);
        // A provider process queries ActivityManager before creating an Activity.
        // Its capabilities must not depend on the game's window initialization.
        var context=maclauncher.android.framework.HostApplication.applicationContext();
        var activity=context.getSystemService(ActivityManager.class);
        int graphicsVersion=activity.getDeviceConfigurationInfo().reqGlEsVersion;
        check(graphicsVersion>=0x20000);
        var features=context.getPackageManager().getSystemAvailableFeatures();
        for(var feature:features)if(feature.name!=null){
            check(context.getPackageManager().hasSystemFeature(feature.name,feature.version));
            check(!context.getPackageManager().hasSystemFeature(feature.name,feature.version+1));
        }
        int vulkan=maclauncher.android.bridge.Graphics.vulkanVersion();
        var vulkanFeatures=java.util.Arrays.stream(features).filter(value->android.content.pm.PackageManager.FEATURE_VULKAN_HARDWARE_VERSION.equals(value.name)).toList();
        check(vulkan==0?vulkanFeatures.isEmpty():vulkanFeatures.size()==1&&vulkanFeatures.getFirst().version==vulkan);
        int level=maclauncher.android.bridge.Graphics.vulkanHardwareLevel();
        var levels=java.util.Arrays.stream(features).filter(value->android.content.pm.PackageManager.FEATURE_VULKAN_HARDWARE_LEVEL.equals(value.name)).toList();
        check(vulkan==0?levels.isEmpty():levels.size()==1&&levels.getFirst().version==level);
        var graphics=java.util.Arrays.stream(features).filter(value->value.name==null).toList();
        check(graphics.size()==1&&graphics.getFirst().reqGlEsVersion==graphicsVersion);
        check(context.getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_TOUCHSCREEN));
        check(!context.getPackageManager().hasSystemFeature("org.example.absent.hardware"));
        check(((EGL10)EGLContext.getEGL()).eglGetCurrentContext().equals(EGL10.EGL_NO_CONTEXT));
        Model m=new Model();check(HostActivityManager.queryGraphics(m.api())==0x30000&&m.calls.getLast().equals("eglTerminate")&&m.contexts.isEmpty());
        m=new Model();m.minor=1;check(HostActivityManager.queryGraphics(m.api())==0x30001&&m.contexts.isEmpty());
        m=new Model();m.minor=2;check(HostActivityManager.queryGraphics(m.api())==0x30002&&m.contexts.isEmpty());
        m=new Model();m.es3=false;check(HostActivityManager.queryGraphics(m.api())==0x20000);
        m=new Model();m.es2=false;m.es3=false;check(HostActivityManager.queryGraphics(m.api())==0);
        m=new Model();m.current=5;failure(m);check(m.calls.size()==1);
        m=new Model();m.initialize=false;failure(m);check(!m.calls.contains("eglTerminate"));
        m=new Model();m.fail="eglChooseConfig";m.terminate=false;var error=failure(m);check(error instanceof IllegalArgumentException&&error.getSuppressed().length==1&&m.calls.getLast().equals("eglTerminate"));
        System.out.println("PASS queried EGL capability and AOSP configuration");
    }
}
