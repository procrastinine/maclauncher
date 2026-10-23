import java.net.URLClassLoader;
import java.nio.file.Path;
public final class ClassLookupProbe {
    private static native void setup(String self,String[] libraries,Class<?> a,Class<?> b);
    private static native Class<?> lookup(int guest,String name,boolean pending);
    private static native void share(Class<?> b);
    private static native void activeUse(Class<?> type);
    private static native Class<?> hostLookup(String name);
    private static native void descriptors(java.io.FileDescriptor value,Class<?> unrelated);
    public static final class Unrelated {public int descriptor=42;}
    public static final class HostTarget {static {System.setProperty("fixture.host.initialized","yes");}}
    private static void require(boolean okay,String message){if(!okay)throw new AssertionError(message);}
    private static void absent(int guest,String name){try{lookup(guest,name,false);throw new AssertionError("Unexpected class visibility: "+name);}catch(NoClassDefFoundError expected){require(expected.getMessage().equals(name),"original FindClass exception changed");}}
    public static void main(String[] args)throws Exception {
        System.load(args[0]);
        try(var a=new URLClassLoader(new java.net.URL[]{Path.of(args[4]).toUri().toURL()},ClassLoader.getPlatformClassLoader());var b=new URLClassLoader(new java.net.URL[]{Path.of(args[5]).toUri().toURL()},ClassLoader.getPlatformClassLoader())){
            Class<?> first=Class.forName("sample.Target",false,a),second=Class.forName("sample.Target",false,b);
            setup(args[0],new String[]{args[1],args[2],args[3]},first,second);
            Path file=java.nio.file.Files.createTempFile("jni-descriptor-",".data");
            try(var stream=new java.io.FileOutputStream(file.toFile())){
                descriptors(stream.getFD(),Unrelated.class);
                stream.write(91);
            }finally{java.nio.file.Files.delete(file);}
            require(lookup(0,"sample/Target",false)==first,"first image loader lost");
            require(System.getProperty("fixture.class.initialized")==null,"guest FindClass initialized on native worker");
            require(lookup(1,"sample/Target",false)==second,"second image loader lost");
            require(lookup(0,"[[Lsample/Target;",false).getComponentType().getComponentType()==first,"array class owner lost");
            require(lookup(0,"java/lang/String",false)==String.class,"normal JNI lookup changed");
            absent(0,"sample/Missing");absent(2,"sample/Target");
            try{lookup(0,"sample/Target",true);throw new AssertionError("Pending exception cleared");}catch(IllegalStateException expected){require(expected.getMessage().equals("original-pending"),"pending exception changed");}
            Class<?> broken=lookup(0,"sample/Broken",false);
            require(broken!=null,"class resolution ran a failing initializer");
            try{activeUse(broken);throw new AssertionError("Initializer failure hidden");}catch(ExceptionInInitializerError expected){require(expected.getCause() instanceof IllegalStateException,"initializer exception changed");}
            activeUse(first);
            require("main".equals(System.getProperty("fixture.class.initialized")),"JNI active use did not initialize on the calling thread");
            require(hostLookup("ClassLookupProbe$HostTarget")==HostTarget.class&&"yes".equals(System.getProperty("fixture.host.initialized")),"host JNI initialization changed");
            share(second);absent(0,"sample/Target");
            require(lookup(1,"sample/Target",false)==second,"sharing another image changed this owner");
            System.out.println("PASS native worker image loaders, arrays, original exceptions and ambiguous ownership");
        }
    }
}
