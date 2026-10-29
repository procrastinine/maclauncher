package maclauncher.android;
import java.nio.file.*;
import java.util.jar.*;
import org.objectweb.asm.*;
import maclauncher.android.RuntimeBootstrap;
import maclauncher.android.framework.*;

public final class RegistrationDescriptorsProbe {
    private static void cursorParcels(){
        for(int size:new int[]{64,32768}){
            byte[] payload=new byte[size];for(int i=0;i<size;i++)payload[i]=(byte)(i*17);
            android.database.CursorWindow transferred;
            try(var original=new android.database.CursorWindow("registration.cursor",128*1024)){
                original.setStartPosition(7);
                if(!original.setNumColumns(3)||!original.allocRow()||
                    !original.putLong(0x1ffedcba98765432L,7,0)||!original.putString("parcel 雪🙂",7,1)||!original.putBlob(payload,7,2))
                    throw new AssertionError("Original CursorWindow could not store parcel values");
                var parcel=android.os.Parcel.obtain();
                try{original.writeToParcel(parcel,0);parcel.setDataPosition(0);transferred=android.database.CursorWindow.CREATOR.createFromParcel(parcel);}
                finally{parcel.recycle();}
            }
            try(transferred){
                if(transferred.getStartPosition()!=7||transferred.getNumRows()!=1||
                    transferred.getLong(7,0)!=0x1ffedcba98765432L||!"parcel 雪🙂".equals(transferred.getString(7,1))||
                    !java.util.Arrays.equals(payload,transferred.getBlob(7,2)))
                    throw new AssertionError("Original CursorWindow parcel values/lifetime differ at "+size);
            }
        }
    }
    private static void concrete(Class<?> owner,String name,Class<?> result,Class<?>...arguments)throws Exception{
        var method=owner.getDeclaredMethod(name,arguments);
        if(method.getReturnType()!=result||java.lang.reflect.Modifier.isNative(method.getModifiers()))
            throw new AssertionError("Original native boundary has no concrete platform body: "+method);
    }
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Files.createDirectories(Path.of(args[1]));
        RuntimeBootstrap.initialize(runtime,data,Files.createDirectories(data.resolve("files")),Files.createDirectories(data.resolve("cache")),"registration.probe",false,false,false);
        var paint=new android.graphics.Paint();
        var pointer=android.graphics.Paint.class.getDeclaredField("mNativePaint");pointer.setAccessible(true);
        // AOSP declares a second nGetRunCharacterAdvance only for Robolectric
        // and registers just the RunInfo descriptor; the device binding is used.
        Class<?>[] args11={long.class,char[].class,int.class,int.class,int.class,int.class,boolean.class,int.class,float[].class,int.class,android.graphics.RectF.class,Class.forName("android.graphics.Paint$RunInfo")};
        var current=android.graphics.Paint.class.getDeclaredMethod("nGetRunCharacterAdvance",args11);current.setAccessible(true);
        float[] advances=new float[4];var bounds=new android.graphics.RectF();
        Object value=current.invoke(null,pointer.getLong(paint),"text".toCharArray(),0,4,0,4,false,4,advances,0,bounds,null);
        if(!(value instanceof Float advance)||!(advance>0)||!(advances[3]>0))throw new AssertionError("Original Paint descriptor did not shape text");
        // A concrete Java platform body still has to retain each original API
        // descriptor; absence of a publisher-family bind is not evidence for it.
        concrete(android.media.ImageReader.class,"nativeCreateImagePlanes",android.media.ImageReader.ImagePlane[].class,
            int.class,android.graphics.GraphicBuffer.class,int.class,int.class,int.class,int.class,int.class,int.class);
        concrete(android.media.ImageReader.class,"nativeUnlockGraphicBuffer",void.class,android.graphics.GraphicBuffer.class);
        concrete(Class.forName("android.media.ImageReader$SurfaceImage"),"nativeGetHardwareBuffer",android.hardware.HardwareBuffer.class);
        cursorParcels();
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
