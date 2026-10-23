package maclauncher.android;

public final class InstalledResourceWriter {
    public static void main(String[] args)throws Exception{
        SyntheticResources.apk(java.nio.file.Path.of(args[0]),"","first package",null);
        SyntheticResources.apk(java.nio.file.Path.of(args[1]),"","second package",null);
    }
}
