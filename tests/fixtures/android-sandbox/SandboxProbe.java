import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Disposable canaries only; the harness supplies every path. */
public final class SandboxProbe {
    private static native int nativeAccess(String path, boolean write);
    private static int checks;
    private static final ArrayList<String> failures=new ArrayList<>();
    private static void check(boolean condition,String label){checks++;if(!condition)failures.add(label);}
    private static boolean denied(IOException error){return error instanceof AccessDeniedException||
        error instanceof FileSystemException&&("Operation not permitted".equals(((FileSystemException)error).getReason())||"Permission denied".equals(((FileSystemException)error).getReason()));}
    private static void deniedFile(Path file,boolean write,String label){
        boolean blocked=false;
        try {
            if(write){try(var out=Files.newOutputStream(file,StandardOpenOption.WRITE)){out.write(88);}}
            else try(var in=Files.newInputStream(file)){in.read();}
        }catch(IOException error){blocked=denied(error);}catch(SecurityException error){blocked=true;}
        check(blocked,"Java "+label+(write?" write":" read"));
        int result=nativeAccess(file.toString(),write);
        check(result==1||result==13,"JNI "+label+(write?" write":" read")+" errno="+result);
    }
    public static void main(String[] args)throws Exception {
        if(args.length!=8||!args[0].equals("--probe"))throw new IllegalArgumentException("Expected owned canary paths");
        boolean child=args[1].equals("child");
        Path owned=Path.of(args[2]),outside=Path.of(args[3]),other=Path.of(args[4]),runtime=Path.of(args[5]),link=Path.of(args[6]);
        System.load(args[7]);
        Path own=owned.resolve(child?"child-owned":"parent-owned");Files.writeString(own,"owned");
        check(Files.readString(own).equals("owned"),"Java own read/write");
        check(nativeAccess(own.toString(),false)==0&&nativeAccess(own.toString(),true)==0,"JNI own read/write");
        for(boolean write:new boolean[]{false,true}){
            deniedFile(outside,write,"outside canary");deniedFile(other,write,"other application canary");deniedFile(link,write,"linked outside canary");
        }
        check(Files.readString(runtime).equals("runtime canary"),"runtime read permitted");
        check(nativeAccess(runtime.toString(),false)==0,"JNI runtime read permitted");
        deniedFile(runtime,true,"runtime canary");
        boolean linkBlocked=false;
        try{Files.createLink(owned.resolve(child?"child-runtime-link":"parent-runtime-link"),runtime);}
        catch(IOException error){linkBlocked=denied(error);}catch(SecurityException error){linkBlocked=true;}
        check(linkBlocked,"read-only runtime cannot be linked into writable data");
        if(!child){
            check(System.getProperty("java.home").equals(System.getProperty("probe.expected.java.home")),"application entry retains original JDK home");
            String[] next=args.clone();next[1]="child";
            var command=new ArrayList<>(List.of(Path.of(System.getProperty("java.home"),"bin/java").toString(),
                "-Xcheck:jni","-XX:-UsePerfData","-Xmx64m","-Duser.home="+System.getProperty("user.home"),
                "-Djava.io.tmpdir="+System.getProperty("java.io.tmpdir"),"-cp",System.getProperty("java.class.path"),"SandboxProbe"));
            command.addAll(Arrays.asList(next));Path log=owned.resolve("child.log");
            Process process=new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(log.toFile()).start();
            boolean stopped=process.waitFor(8,TimeUnit.SECONDS);
            if(!stopped){process.destroyForcibly();process.waitFor(2,TimeUnit.SECONDS);}
            String output;try(var in=Files.newInputStream(log)){output=new String(in.readNBytes(16384),java.nio.charset.StandardCharsets.UTF_8);}
            check(stopped&&process.exitValue()==0&&output.contains("PASS sandbox child"),"child inherits file denial: "+output);
            System.out.print(output);
        }
        if(!failures.isEmpty())throw new AssertionError(String.join("; ",failures));
        System.out.println("PASS sandbox "+(child?"child":"parent")+" checks="+checks);
    }
}
