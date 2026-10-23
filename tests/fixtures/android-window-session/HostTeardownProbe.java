package maclauncher.android;

import maclauncher.android.bridge.WindowSession;

/** Actual Java and C session owners; only physical device callbacks are injected. */
public final class HostTeardownProbe {
 private static native void install();
 private static native void configure(int callbacks,boolean unbind,boolean failInitialization);
 private static native int[] statistics();
 private static native boolean claim();
 private static native boolean release(boolean drained);
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 private static Throwable fails(Class<? extends Throwable> type,Runnable action){
  try{action.run();}catch(Throwable error){check(type.isInstance(error),"Unexpected failure: "+error);return error;}
  throw new AssertionError("Expected "+type.getSimpleName());
 }
 private static void retained(String operation){
  int[] state=statistics();
  check(WindowSession.attached(),operation+" retains Java session");
  check(state[4]==15&&state[5]==0,operation+" retains display, layer, window and video");
 }
 public static void main(String[] args)throws Exception{
  System.load(args[0]);install();
  check(!WindowSession.attached(),"class initialization creates no session");
  fails(NullPointerException.class,()->WindowSession.open(null,320,240));
  fails(IllegalArgumentException.class,()->WindowSession.open("invalid",0,240));
  fails(IllegalArgumentException.class,()->WindowSession.open("invalid",320,8193));
  check(statistics()[0]==0,"invalid arguments never allocate a native owner");

  configure(-1,true,false);int[] closeRequests={0},pumps={0};
  WindowSession session=WindowSession.open("retirement",320,240,()->closeRequests[0]++);
  retained("open");
  int[] before=statistics();Throwable[] threadFailure={null};
  Thread other=new Thread(()->{
   try{
    fails(IllegalStateException.class,()->session.stopCallbacks(()->{}));
    fails(IllegalStateException.class,session::close);
    fails(IllegalStateException.class,WindowSession::requestClose);
   }catch(Throwable error){threadFailure[0]=error;}
  });other.start();other.join();
  check(threadFailure[0]==null,"foreign thread rejected: "+threadFailure[0]);
  check(java.util.Arrays.equals(before,statistics()),"foreign thread never enters native owner");
  WindowSession.requestClose();WindowSession.requestClose();
  check(closeRequests[0]==1,"close gesture notifies exactly once");

  fails(IllegalStateException.class,()->session.stopCallbacks(()->pumps[0]++));
  check(pumps[0]==1,"owner work can run while callbacks drain");retained("busy callback stop");
  fails(IllegalStateException.class,session::close);retained("busy callback close");
  configure(0,true,false);
  fails(IllegalStateException.class,()->session.stopCallbacks(()->{}));retained("failed callback stop");
  Error pumpFailure=new AssertionError("owner task failed");int stops=statistics()[2];
  check(fails(AssertionError.class,()->session.stopCallbacks(()->{throw pumpFailure;}))==pumpFailure,"owner task failure preserved");
  check(statistics()[2]==stops,"pending Java exception prevents further native work");retained("owner task failure");

  configure(1,false,false);session.stopCallbacks(()->{});
  fails(IllegalStateException.class,session::close);retained("failed display unbind");
  configure(1,true,false);check(claim(),"producer claims existing session");
  stops=statistics()[2];fails(IllegalStateException.class,session::close);
  check(statistics()[2]==stops,"claimed producer prevents close before callback retirement");
  check(!release(false),"undrained producer cannot release");retained("active producer");
  check(release(true),"drained producer releases after callbacks stop");
  session.close();check(!WindowSession.attached(),"successful close clears current owner");
  int[] closed=statistics();check(closed[4]==0&&closed[5]==1234,"unbind then layer, window, video released in order");
  session.close();session.stopCallbacks(()->{throw new AssertionError("closed session pump");});WindowSession.requestClose();
  check(java.util.Arrays.equals(closed,statistics())&&closeRequests[0]==1,"closed session is idempotent");

  configure(-1,true,false);WindowSession failed=WindowSession.open("failure",320,240);
  Error primary=new AssertionError("original rendering failure");
  try(failed){throw primary;}catch(Throwable error){
   check(error==primary,"rendering failure remains primary");
   check(error.getSuppressed().length==1&&error.getSuppressed()[0] instanceof IllegalStateException,"failed close is suppressed");
  }
  retained("exceptional presentation exit");
  configure(1,true,false);failed.stopCallbacks(()->{});failed.close();

  configure(1,true,true);int closedCount=statistics()[1];
  Throwable initialization=fails(IllegalStateException.class,()->WindowSession.open("failed initialization",320,240));
  check(initialization.getMessage().equals("native initialization failed"),"initialization error preserved");
  int[] finalState=statistics();
  check(!WindowSession.attached()&&finalState[1]==closedCount+1&&finalState[4]==0&&finalState[5]==1234,"partial initialization retires without publishing owner");
  System.out.println("PASS native session retirement: callback and producer barriers, owner thread, ordered cleanup and retry");
 }
}
