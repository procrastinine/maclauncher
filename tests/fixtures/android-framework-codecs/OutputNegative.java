import android.util.*;import java.io.*;import java.lang.reflect.*;
public final class OutputNegative{
 public static void main(String[]args)throws Exception{
  if(args[0].equals("memory")){
   var stream=new Base64OutputStream(OutputStream.nullOutputStream(),Base64.NO_WRAP);byte[] chunk=new byte[1<<20];stream.write(chunk);
   var f=Base64OutputStream.class.getDeclaredField("coder");f.setAccessible(true);var coder=f.get(stream);var output=coder.getClass().getSuperclass().getField("output");output.setAccessible(true);byte[] scratch=(byte[])output.get(coder);
   var max=coder.getClass().getMethod("maxOutputSize",int.class);max.setAccessible(true);
   if(scratch.length!=(int)max.invoke(coder,chunk.length))throw new AssertionError("Original scratch does not match the maximum input chunk");
   for(int i=1;i<64;i++){stream.write(chunk);if(output.get(coder)!=scratch)throw new AssertionError("Same-sized chunks grew or replaced original scratch");}
   stream.close();if(output.get(coder)!=scratch)throw new AssertionError("Finalization replaced reusable scratch");
  } else {
   var failure=new IOException("same failing sink");var sink=new OutputStream(){public void write(int b)throws IOException{throw failure;}public void close()throws IOException{throw failure;}};var stream=new Base64OutputStream(sink,Base64.NO_WRAP);stream.write(1);
   // AOSP calls Throwable.addSuppressed even when both operations throw the
   // same object; Java rejects self-suppression and retains that object as cause.
   try{stream.close();throw new AssertionError();}catch(IllegalArgumentException expected){if(expected.getCause()!=failure)throw new AssertionError("Original self-suppression cause changed");}
  }
 }
}
