public final class NativeBridgeProbe {
 public static void main(String[] arguments)throws Exception {
  Class<?> runtime=Class.forName("dalvik.system.VMRuntime");
  if(!Boolean.TRUE.equals(runtime.getMethod("is64Bit").invoke(runtime.getMethod("getRuntime").invoke(null))))throw new AssertionError("Executing ART width changed with the translated library");
  for(String directory:new String[]{arguments[1],arguments[3]}){
  ClassLoader owner=(ClassLoader)Class.forName("dalvik.system.PathClassLoader")
   .getConstructor(String.class,String.class,ClassLoader.class)
   .newInstance(arguments[0],directory,ClassLoader.getSystemClassLoader().getParent());
  try{owner.loadClass("ArtSharedJniProbe").getMethod("main",String[].class).invoke(null,(Object)new String[]{arguments[2]});}
  catch(java.lang.reflect.InvocationTargetException failure){throw new AssertionError("Original native library load failed",failure.getCause());}
  if(!Integer.valueOf(19).equals(owner.loadClass("ArtSharedJniProbe").getMethod("dependency").invoke(null)))throw new AssertionError("Original NativeBridge JNI lookup lost its dependency group");
  Class<?> assets=Class.forName("android.content.res.AssetManager");
  Object manager=assets.getConstructor().newInstance();
  String apk=arguments.length>4?arguments[4]:arguments[0];
  if(((Integer)assets.getMethod("addAssetPath",String.class).invoke(manager,apk))==0)throw new AssertionError("Original AssetManager rejected APK");
  int checked=0;
  try(java.util.zip.ZipFile zip=new java.util.zip.ZipFile(apk)){
   java.util.Enumeration<? extends java.util.zip.ZipEntry> entries=zip.entries();
   while(entries.hasMoreElements()){
    java.util.zip.ZipEntry entry=entries.nextElement();if(entry.isDirectory()||!entry.getName().startsWith("assets/"))continue;
    int hash=0x811c9dc5;byte[] bytes=new byte[4096];
    try(java.io.InputStream input=zip.getInputStream(entry)){int size;while((size=input.read(bytes))>=0)for(int i=0;i<size;i++)hash=(hash^(bytes[i]&255))*16777619;}
    Object actual=owner.loadClass("ArtSharedJniProbe").getMethod("asset",Object.class,String.class,long.class).invoke(null,manager,entry.getName().substring(7),entry.getSize());
    if(((Long)actual).longValue()!=Integer.toUnsignedLong(hash))throw new AssertionError("Original AAsset read/seek failed: "+entry.getName()+" result="+actual+" expected="+Integer.toUnsignedLong(hash));
    ++checked;
   }
  }finally{assets.getMethod("close").invoke(manager);}
  if(checked==0)throw new AssertionError("No asset reads exercised");
  System.out.println("PASS original AssetManager ARM32 open/read/length/seek: "+checked+" assets");
  }
  System.out.println("PASS original ART System.load, class-loader namespace, JNI_OnLoad and shared ARM32 JNI");
 }
}
