package maclauncher.android.media;

public final class StreamActivityProbe {
    private static native void install();
    private static native void playing(int stream,boolean active);
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args){
        try{
            System.setProperty("klepton.audio",args[0]);
            System.load(args[1]);System.load(args[2]);install();
            check(!HostAudioManager.streamActive(3,0),"idle stream must not be active");
            playing(3,true);
            check(HostAudioManager.streamActive(3,0),"native-only player is active");
            check(AudioHost.streamActive(3,0),"compatibility client uses the same owner");
            check(!HostAudioManager.streamActive(4,0),"different stream stays idle");
            playing(3,false);
            check(!HostAudioManager.streamActive(3,0),"stopped player is not current");
            check(HostAudioManager.streamActive(3,1234),"recent activity interval reaches the owner");
            check(!HostAudioManager.streamActive(3,-1),"invalid history interval has no activity");
            System.out.println("PASS native stream activity binding, native-only playback and recent history");
            System.exit(0);
        }catch(Throwable failure){failure.printStackTrace();System.exit(1);}
    }
}
