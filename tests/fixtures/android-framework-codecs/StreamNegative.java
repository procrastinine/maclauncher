import android.util.*;import java.io.*;
public final class StreamNegative{
 public static void main(String[]args)throws Exception{
  var in=new Base64InputStream(new ByteArrayInputStream("Zm9v".getBytes()){public synchronized int read(byte[] b,int o,int n){return super.read(b,o,Math.min(n,1));}},Base64.DEFAULT);
  int first=in.read();if(first!='f')throw new AssertionError("valid short read returned premature EOF: "+first);in.close();
 }
}
