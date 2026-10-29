import android.util.*;import java.io.*;
public final class StreamNegative{
 public static void main(String[]args)throws Exception{
  var in=new Base64InputStream(new ByteArrayInputStream("Zm9v".getBytes()){public synchronized int read(byte[] b,int o,int n){return super.read(b,o,Math.min(n,1));}},Base64.DEFAULT);
  for(int i=0;i<3;i++)if(in.read()!=-1)throw new AssertionError("Original fragmented decoder published an incomplete tuple");
  if(in.read()!='f'||in.read()!='o'||in.read()!='o'||in.read()!=-1)throw new AssertionError("Resuming after original early EOF lost decoded data");in.close();
 }
}
