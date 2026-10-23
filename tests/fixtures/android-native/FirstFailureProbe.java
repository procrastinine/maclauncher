package maclauncher.android;
public final class FirstFailureProbe {
 public static void main(String[] args)throws Exception{
  if(args.length>0){workers();return;}
  var bytes=new java.io.ByteArrayOutputStream();var old=System.err;System.setErr(new java.io.PrintStream(bytes,true,java.nio.charset.StandardCharsets.UTF_8));
  try{
   var original=new IllegalStateException("original-startup-failure"+"x".repeat(50000));
   FirstFailure.report(original);FirstFailure.report(original);
   String primary=bytes.toString(java.nio.charset.StandardCharsets.UTF_8);
   if(!primary.startsWith("[android-host] Failure:\n")||!primary.contains("original-startup-failure")||!primary.contains("[message truncated]")||bytes.size()>8192)throw new AssertionError("Primary diagnostic bounds");
   var secondary=new IllegalStateException("later cleanup failure");
   secondary.setStackTrace(new StackTraceElement[]{new StackTraceElement("Long"+"y".repeat(50000),"method","Example.java",1)});
   FirstFailure.report(secondary);FirstFailure.report(secondary);FirstFailure.report(new IllegalStateException("unbounded extra owner"));
   String text=bytes.toString(java.nio.charset.StandardCharsets.UTF_8);
   if(!text.startsWith(primary)||!text.contains("[android-host] Secondary failure:\n")||!text.contains("later cleanup failure")||!text.contains("[Android error report truncated]")||text.contains("unbounded extra owner")||bytes.size()>16384)throw new AssertionError("Secondary diagnostic bounds");
   FirstFailure.reportWorker(Thread.currentThread(),new IllegalStateException("worker failure"));
   FirstFailure.reportWorker(Thread.currentThread(),new IllegalStateException("unbounded extra worker"));
   text=bytes.toString(java.nio.charset.StandardCharsets.UTF_8);
   if(!text.contains("worker failure")||text.contains("unbounded extra worker")||text.split("\\[android-host\\]",-1).length!=4||bytes.size()>24576)throw new AssertionError("Diagnostic slots or byte cap");
  }finally{System.setErr(old);}
  System.out.println("PASS primary and secondary failures retain order, deduplicate and bound message/report bytes");
 }
 private static void workers()throws Exception{
  var bytes=new java.io.ByteArrayOutputStream();var previous=System.err;var handler=Thread.getDefaultUncaughtExceptionHandler();
  var forwarded=new java.util.concurrent.atomic.AtomicInteger();var error=new IllegalStateException("optional sdk callback");
  Thread.setDefaultUncaughtExceptionHandler((thread,failure)->{if(failure!=error)throw new AssertionError();forwarded.incrementAndGet();});
  var installed=Thread.getDefaultUncaughtExceptionHandler();System.setErr(new java.io.PrintStream(bytes,true,java.nio.charset.StandardCharsets.UTF_8));
  try{
   try(var scope=FirstFailure.captureWorkers()){
    Thread worker=new Thread(()->{throw error;},"optional-sdk");worker.start();worker.join(2000);
    if(worker.isAlive()||forwarded.get()!=1)throw new AssertionError("worker scope/handler");
    String text=bytes.toString(java.nio.charset.StandardCharsets.UTF_8);
    if(!text.startsWith("[android-host] Background worker error:\n")||text.contains("[android-host] Failure:")||text.contains("Secondary failure:"))throw new AssertionError("worker poisoned host failure");
    FirstFailure.reportOwner(error); // The same Throwable reaching the owner is now fatal.
    text=bytes.toString(java.nio.charset.StandardCharsets.UTF_8);
    if(!text.contains("[android-host] Failure:\n")||!text.contains("role=owner"))throw new AssertionError("owner failure suppressed");
   }
   if(Thread.getDefaultUncaughtExceptionHandler()!=installed)throw new AssertionError("handler not restored");
  }finally{Thread.setDefaultUncaughtExceptionHandler(handler);System.setErr(previous);}
  System.out.println("PASS worker diagnostics stay local and owner failures remain fatal");
 }
}
