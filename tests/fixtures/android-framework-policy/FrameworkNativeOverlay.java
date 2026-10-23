import java.nio.file.*;
import java.util.zip.ZipFile;

/** Runs the production native-boundary adaptation over complete framework classes. */
public final class FrameworkNativeOverlay {
    public static void main(String[] args)throws Exception{
        try(var archive=new ZipFile(args[0])){
            for(int i=2;i<args.length;i++){
                String name=args[i]+".class";
                try(var input=archive.getInputStream(archive.getEntry(name))){
                    Path output=Path.of(args[1],name);Files.createDirectories(output.getParent());
                    Files.write(output,NativeBindings.transform(input.readAllBytes()));
                }
            }
        }
    }
}
