import maclauncher.android.media.MediaInputs;
public final class MediaOffProbe {
    private static void check(boolean value){if(!value)throw new AssertionError();}
    interface Open{long open();}
    private static void denied(Open operation){try{check(operation.open()==0);}catch(SecurityException expected){}}
    public static void main(String[] args){
        MediaInputs.configure(null,null);
        check(!MediaInputs.isGranted("android.permission.CAMERA"));check(!MediaInputs.isGranted("android.permission.RECORD_AUDIO"));
        denied(MediaInputs::cameraOpen);denied(()->MediaInputs.audioOpen(48000,1));
        check(MediaInputs.cameraSizes().length==0);
        check(!MediaInputs.cameraStart(1,640,480));
        MediaInputs.hostShutdown();MediaInputs.hostShutdown();check(!MediaInputs.cameraSelected());
        check(!MediaInputs.isGranted("android.permission.RECORD_AUDIO"));
        System.out.println("PASS Off: no selected device grant, camera refused, terminal cleanup");
    }
}
