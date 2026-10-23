import java.net.*;
import java.nio.*;
import java.nio.file.*;
import java.lang.reflect.*;
import java.io.*;
public class PortableConversionProbe {
 public static void main(String[] args)throws Exception{
  for(String archive:args)try(var loader=new URLClassLoader(new URL[]{Path.of(archive).toUri().toURL()},PortableConversionProbe.class.getClassLoader())){
   var call=loader.loadClass("fixture.PortableValue").getMethod("offset",ByteBuffer.class);
   ByteBuffer bytes=ByteBuffer.allocate(32);bytes.position(7);
   if(!call.invoke(null,bytes.slice()).equals(7))throw new AssertionError("Original Android NIO slice contract");
   try{call.invoke(null,bytes.asReadOnlyBuffer());throw new AssertionError("Read-only buffer accepted");}
   catch(InvocationTargetException failure){if(!(failure.getCause() instanceof ReadOnlyBufferException))throw failure;}
   var field=loader.loadClass("fixture.PortableValue").getMethod("field",Class.class,String.class);
   Field descriptor=(Field)field.invoke(null,FileDescriptor.class,"descriptor");
   if(!descriptor.equals(FileDescriptor.class.getDeclaredField("fd")))throw new AssertionError("Android descriptor field alias");
   descriptor.setAccessible(true);
   if(descriptor.getInt(FileDescriptor.in)!=0)throw new AssertionError("Descriptor field does not refer to the actual JDK object");
   if(!field.invoke(null,FileDescriptor.class,"fd").equals(FileDescriptor.class.getDeclaredField("fd")))throw new AssertionError("Original JDK field lookup changed");
   if(!field.invoke(null,PortableConversionProbe.class,"descriptor").equals(PortableConversionProbe.class.getDeclaredField("descriptor")))throw new AssertionError("Unrelated descriptor field changed");
   for(Object[] request:new Object[][]{{FileDescriptor.class,"missing"},{String.class,"descriptor"},{FileDescriptor.class,null},{null,"descriptor"}}){
    try{field.invoke(null,request);throw new AssertionError("Invalid reflection accepted");}
    catch(InvocationTargetException failure){
     Throwable cause=failure.getCause();
     if(request[0]==null||request[1]==null){if(!(cause instanceof NullPointerException))throw failure;}
     else if(!(cause instanceof NoSuchFieldException)||!cause.getMessage().equals(request[1]))throw failure;
    }
   }
  }
  System.out.println("PASS original APK and dynamic DEX callers share Android NIO portability");
 }
 private int descriptor;
}
