import android.hardware.Camera;
import maclauncher.android.media.MediaInputs;
public final class MediaOffProbe {
    private static void check(boolean value){if(!value)throw new AssertionError();}
    public static void main(String[] args){
        MediaInputs.configure(null,null);
        check(!MediaInputs.isGranted("android.permission.CAMERA"));check(!MediaInputs.isGranted("android.permission.RECORD_AUDIO"));
        check(Camera.getNumberOfCameras()==0);check(MediaInputs.cameraOpen()==0);
        check(!MediaInputs.isAuthorizedSelection("android.permission.RECORD_AUDIO",""));
        check(!MediaInputs.cameraStart(1,640,480));
        MediaInputs.hostShutdown();MediaInputs.hostShutdown();check(!MediaInputs.cameraSelected());
        check(!MediaInputs.isGranted("android.permission.RECORD_AUDIO"));
        System.out.println("PASS Off: no selected device grant, camera refused, terminal cleanup");
    }
}
