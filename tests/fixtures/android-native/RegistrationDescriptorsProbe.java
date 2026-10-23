package maclauncher.android;
import java.nio.file.*;
import java.util.jar.*;
import org.objectweb.asm.*;
import maclauncher.android.RuntimeBootstrap;
import maclauncher.android.framework.*;

public final class RegistrationDescriptorsProbe {
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Files.createDirectories(Path.of(args[1]));
        RuntimeBootstrap.initialize(runtime,data,Files.createDirectories(data.resolve("files")),Files.createDirectories(data.resolve("cache")),"registration.probe",false,false,false);
        var paint=new android.graphics.Paint();
        var pointer=android.graphics.Paint.class.getDeclaredField("mNativePaint");pointer.setAccessible(true);
        Class<?>[] oldArgs={long.class,char[].class,int.class,int.class,int.class,int.class,boolean.class,int.class,float[].class,int.class,android.graphics.RectF.class};
        var legacy=android.graphics.Paint.class.getDeclaredMethod("nGetRunCharacterAdvance",oldArgs);legacy.setAccessible(true);
        var newArgs=java.util.Arrays.copyOf(oldArgs,oldArgs.length+1);newArgs[oldArgs.length]=Class.forName("android.graphics.Paint$RunInfo");
        var current=android.graphics.Paint.class.getDeclaredMethod("nGetRunCharacterAdvance",newArgs);current.setAccessible(true);
        float[] oldAdvances=new float[4],newAdvances=new float[4];var oldBounds=new android.graphics.RectF();var newBounds=new android.graphics.RectF();
        Object oldValue=legacy.invoke(null,pointer.getLong(paint),"text".toCharArray(),0,4,0,4,false,4,oldAdvances,0,oldBounds);
        Object newValue=current.invoke(null,pointer.getLong(paint),"text".toCharArray(),0,4,0,4,false,4,newAdvances,0,newBounds,null);
        if(!oldValue.equals(newValue)||!java.util.Arrays.equals(oldAdvances,newAdvances)||!oldBounds.equals(newBounds))throw new AssertionError("Legacy Paint descriptor changed original shaping");
        // Compare live bindings with every remaining original native method in
        // the complete normalized archive, including nested classes and overloads.
        try(var archive=new JarFile(runtime.resolve("android-framework.jar").toFile());var output=Files.newBufferedWriter(Path.of(args[2]))){
            for(var entries=archive.entries();entries.hasMoreElements();){var entry=entries.nextElement();if(!entry.getName().endsWith(".class"))continue;
                Path overlay=Path.of(args[3]).resolve(entry.getName());
                var reader=Files.isRegularFile(overlay)?new ClassReader(Files.readAllBytes(overlay)):new ClassReader(archive.getInputStream(entry));
                reader.accept(new ClassVisitor(Opcodes.ASM9){
                    @Override public MethodVisitor visitMethod(int access,String name,String descriptor,String signature,String[] exceptions){
                        if((access&Opcodes.ACC_NATIVE)!=0)try{output.write("L"+reader.getClassName()+";\t"+name+"\t"+descriptor+"\n");}catch(java.io.IOException error){throw new java.io.UncheckedIOException(error);}return null;
                    }
                },ClassReader.SKIP_CODE|ClassReader.SKIP_DEBUG|ClassReader.SKIP_FRAMES);
            }
        }
        HostApplication.shutdown();FrameworkResources.shutdown();
        System.out.println("PASS publisher registration capture");System.exit(0);
    }
}
