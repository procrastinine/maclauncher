package maclauncher.android.bridge;
import java.nio.file.Path;
public final class MetadataProbe {
  public static void main(String[] args)throws Exception {
    var metadata=ElfNativeExports.readMetadata(Path.of(args[0]));
    if(!metadata.dependencies().isEmpty())throw new AssertionError(metadata.dependencies());
    System.out.println("PASS original ARM32 ELF metadata");
  }
}
