import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

public final class NativeProcMapsProbe {
    private static native void configure(byte[][] guest,byte[][] host);
    private static native void probe(String root);
    private static byte[] bytes(String value){return value.getBytes(StandardCharsets.UTF_8);}
    public static void main(String[] args){
        System.load(Path.of(args[1]).toAbsolutePath().toString());
        configure(new byte[][]{bytes("/data/app/maps-fixture.so")},
                  new byte[][]{bytes(Path.of(args[0],"mapped-file").toString())});
        probe(args[0]);
        System.out.println("PASS native self maps, namespace identity, protection refresh and open-inode lifetime");
    }
}
