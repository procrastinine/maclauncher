import maclauncher.android.framework.*;
public final class ProcessMediaProbe {
  private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
  public static void main(String[] args)throws Exception{
    var first=new HostBinderRpc.Peer("example.first","example.first",111,10001,"u:r:untrusted_app:s0");
    var second=new HostBinderRpc.Peer("example.second","example.second",222,10002,"u:r:untrusted_app:s0");
    var again=new HostBinderRpc.Peer("example.first","example.first",333,10001,"u:r:untrusted_app:s0");
    String audio="android.permission.RECORD_AUDIO";
    try(var owner=new HostProcessServices()){
      owner.expectMedia(first,"selected-first","",true);owner.expectMedia(second,"selected-second","selected-camera");
      check(owner.audioMuted(10001)&&!owner.audioMuted(10002),"output mute belongs to authenticated UID");
      var observed=new java.util.ArrayList<String>();
      var policy=owner.audioPolicy((uid,muted)->observed.add(uid+":"+muted));
      check(observed.equals(java.util.List.of("10001:true","10002:false")),"readiness snapshots existing UIDs once");
      try{owner.expectMedia(first,"selected-first","",false);throw new AssertionError("app activation changed immutable mute");}catch(SecurityException expected){}
      check(owner.mediaInput(10001,-1,audio).equals("selected-first"),"first UID selection");
      check(owner.mediaInput(10001,222,audio).isEmpty(),"different PID cannot borrow selection");
      check(owner.mediaInput(10003,-1,audio).isEmpty(),"different UID cannot borrow selection");
      owner.expectMedia(again,"other-first","");
      check(owner.mediaInput(10001,-1,audio).isEmpty(),"ambiguous UID query does not pick a device");
      check(owner.mediaInput(10001,111,audio).equals("selected-first"),"exact original process remains distinct");
      owner.unavailable(first);
      check(!owner.audioMuted(10001),"last muted activation retirement restores UID policy");
      check(observed.get(observed.size()-1).equals("10001:false"),"retirement updates original policy");
      check(owner.mediaInput(10001,111,audio).isEmpty(),"retired process loses choice");
      check(owner.mediaInput(10001,-1,audio).equals("other-first"),"replacement lifetime retained");
      owner.expectMedia(again,"","");
      check(owner.mediaInput(10001,-1,audio).isEmpty(),"explicit off revokes selection");
      owner.close();check(owner.mediaInput(10002,-1,audio).isEmpty(),"owner shutdown revokes selection");
      check(observed.get(observed.size()-1).endsWith(":false"),"shutdown restores playback policy");policy.close();
    }
    System.out.println("PASS media enrollment isolation and retirement");
  }
}
