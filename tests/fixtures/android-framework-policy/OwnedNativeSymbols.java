import java.nio.file.*;
import java.util.*;
import java.util.jar.*;
import java.util.regex.*;
import org.objectweb.asm.*;

/** Compares every compiled native declaration with exports or actual VM bindings. */
public final class OwnedNativeSymbols {
    private static String mangle(String value){
        StringBuilder result=new StringBuilder();
        for(char c:value.toCharArray()){
            if(c>='a'&&c<='z'||c>='A'&&c<='Z'||c>='0'&&c<='9')result.append(c);
            else switch(c){case '/'->result.append('_');case '_'->result.append("_1");case ';'->result.append("_2");case '['->result.append("_3");default->result.append(String.format("_0%04x",(int)c));}
        }
        return result.toString();
    }
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[3]),data=Files.createDirectories(Path.of(args[4]).resolveSibling("data"));
        maclauncher.android.framework.HostFilesystem.configure(runtime,data,
                Files.createDirectories(data.resolve("files")),Files.createDirectories(data.resolve("cache")),"org.example.nativebindings");
        System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());
        System.load(runtime.resolve("native/libnativebinding.dylib").toString());
        maclauncher.android.framework.JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));
        maclauncher.android.framework.JvmNativeMemory.initialize();
        Set<String> exports=new HashSet<>(Files.readAllLines(Path.of(args[1])));
        Set<String> bindings=new HashSet<>(Files.readAllLines(Path.of(args[4])));
        Set<String> registered=new HashSet<>(),declarations=new HashSet<>();
        Matcher registeredEntry=Pattern.compile("\\{\\s*\"([^\"]+)\"\\s*,\\s*\"(\\([^\"]*\\)[^\"]+)\"\\s*,").matcher(Files.readString(Path.of(args[2])));
        while(registeredEntry.find())registered.add(registeredEntry.group(1)+registeredEntry.group(2));
        if(registered.isEmpty())throw new AssertionError("Guest native registration table is missing");
        List<String> missing=new ArrayList<>();int[] count={0};
        try(JarFile host=new JarFile(args[0])){
            for(var entries=host.entries();entries.hasMoreElements();){
                var entry=entries.nextElement();if(!entry.getName().endsWith(".class"))continue;
                byte[] bytes;try(var stream=host.getInputStream(entry)){bytes=stream.readAllBytes();}
                ClassReader reader=new ClassReader(bytes);String owner=reader.getClassName();
                reader.accept(new ClassVisitor(Opcodes.ASM9){
                    @Override public MethodVisitor visitMethod(int access,String name,String descriptor,String signature,String[] exceptions){
                        if((access&Opcodes.ACC_NATIVE)==0)return null;
                        // These entrypoints are deliberately registered on a guest-owned
                        // ClassLoader by NativeBinding.registerEntry, not found by JNI export.
                        if(owner.equals("maclauncher/android/bridge/GuestNativeEntry")){
                            if((access&Opcodes.ACC_STATIC)==0)throw new AssertionError("Guest JNI entry must be static: "+name+descriptor);
                            declarations.add(name+descriptor);return null;
                        }
                        count[0]++;String shortName="Java_"+mangle(owner)+"_"+mangle(name);
                        String longName=shortName+"__"+mangle(descriptor.substring(1,descriptor.indexOf(')')));
                        if(!exports.contains(shortName)&&!exports.contains(longName)&&!bindings.contains(owner+"."+name+descriptor))missing.add(owner+"."+name+descriptor);
                        return null;
                    }
                },ClassReader.SKIP_CODE|ClassReader.SKIP_DEBUG|ClassReader.SKIP_FRAMES);
            }
        }
        if(!declarations.equals(registered))throw new AssertionError("Guest JNI registration/declaration mismatch: declarations="+declarations+" registered="+registered);
        if(!missing.isEmpty())throw new AssertionError("Missing owned JNI implementations ("+missing.size()+"):\n"+String.join("\n",missing));
        System.out.println("PASS "+count[0]+" owned native declarations retain exported or registered JNI implementations");
    }
}
