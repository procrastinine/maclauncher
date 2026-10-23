package maclauncher.android.tests;
public final class UnavailableServicesProbe {
 public static void main(String[]args)throws Exception{
  var context=maclauncher.android.NativeProbeFixture.current.context;var previous=System.err;var bytes=new java.io.ByteArrayOutputStream();
  if(!context.getClass().getName().equals("android.app.ContextImpl"))throw new AssertionError("Original context required");
  System.setErr(new java.io.PrintStream(bytes,true,java.nio.charset.StandardCharsets.UTF_8));
  try{
   for(int i=0;i<100;i++)if(context.getSystemService("unknown-service")!=null)throw new AssertionError();
   if(context.getSystemService(String.class)!=null)throw new AssertionError("unavailable typed service");
   if(context.getSystemService((Class<?>)null)!=null)throw new AssertionError("absent service class");
   for(int i=0;i<100;i++)if(context.getSystemService("absent-"+i)!=null)throw new AssertionError();
   String text=bytes.toString(java.nio.charset.StandardCharsets.UTF_8);
   if(!text.isEmpty())throw new AssertionError("Unknown services must retain original silent absence: "+text);
  }finally{System.setErr(previous);}
  Object token=new Object();android.content.Context custom=new android.content.ContextWrapper(context){
   @Override public String getSystemServiceName(Class<?> type){return "owned";}
   @Override public Object getSystemService(String name){return name.equals("owned")?token:null;}
  };
  if(custom.getSystemService(Object.class)!=token)throw new AssertionError("typed lookup lost Context dispatch");
  if(context.getSystemService(android.media.AudioManager.class)!=context.getSystemService("audio"))throw new AssertionError("implemented service changed");
  System.out.println("PASS unavailable services return null with bounded diagnostics");
 }
}
