public final class ArtArm32Probe {
 private static native void run(byte[] code);
 private static int callback(int value){
  System.gc();
  if(value==99)throw new IllegalArgumentException("original ART exception");
  return value*7+1;
 }
 public static void main(String[] args)throws Exception{
  System.load(args[0]);
  java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();
  try(java.io.InputStream input=new java.io.FileInputStream(args[1])){
   byte[] block=new byte[4096];int count;while((count=input.read(block))!=-1)bytes.write(block,0,count);
  }
  byte[] code=bytes.toByteArray();
  run(code);
  final Throwable[] failure=new Throwable[1];
  Thread thread=new Thread(()->{try{run(code);}catch(Throwable error){failure[0]=error;}});
  thread.start();thread.join();if(failure[0]!=null)throw new AssertionError(failure[0]);
  System.out.println("PASS original ART + shared ARM32 CPU: wide arguments, JNI callback, GC, exception, thread retirement");
 }
}
