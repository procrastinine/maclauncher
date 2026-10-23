import android.util.*;import java.io.*;import java.lang.reflect.*;
public final class OutputNegative{
 public static void main(String[]args)throws Exception{
  if(args[0].equals("memory")){var stream=new Base64OutputStream(OutputStream.nullOutputStream(),Base64.NO_WRAP);stream.write(new byte[8*1024*1024]);var f=Base64OutputStream.class.getDeclaredField("coder");f.setAccessible(true);var coder=f.get(stream);var output=coder.getClass().getSuperclass().getField("output");output.setAccessible(true);int bytes=((byte[])output.get(coder)).length;stream.close();if(bytes>4096)throw new AssertionError("Retained stream scratch is proportional to caller input: "+bytes);}
  else {var failure=new IOException("same failing sink");var sink=new OutputStream(){public void write(int b)throws IOException{throw failure;}public void close()throws IOException{throw failure;}};var stream=new Base64OutputStream(sink,Base64.NO_WRAP);stream.write(1);try{stream.close();throw new AssertionError();}catch(IOException expected){if(expected!=failure)throw new AssertionError("First error replaced");}}
 }
}
