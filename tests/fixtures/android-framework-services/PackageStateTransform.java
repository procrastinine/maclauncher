import java.nio.file.*;
public final class PackageStateTransform {
    public static void main(String[] args)throws Exception {
        Path file=Path.of(args[0],"PackageStateProbe$Queries.class");
        Files.write(file,ServicePortability.transform("PackageStateProbe$Queries.class",Files.readAllBytes(file)));
    }
}
