import java.nio.file.*;
import java.util.jar.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

public final class ScrollInputTransform {
    public static void main(String[] args)throws Exception {
        String name="android/view/ViewRootImpl.class";byte[] original;
        try(var jar=new JarFile(args[0]);var input=jar.getInputStream(jar.getJarEntry(name))){original=input.readAllBytes();}
        ClassNode node=new ClassNode();new ClassReader(original).accept(node,0);
        // Existing runtimes already carry all other original UI adaptations.
        if(node.methods.stream().flatMap(m->java.util.Arrays.stream(m.instructions.toArray())).noneMatch(i->i instanceof MethodInsnNode call&&call.owner.equals("maclauncher/android/framework/HostWindowManager")&&call.name.equals("inputFinished")))UiHookClassFiles.apply(node);
        ClassWriter writer=new ClassWriter(ClassWriter.COMPUTE_FRAMES|ClassWriter.COMPUTE_MAXS);node.accept(writer);
        Path output=Path.of(args[1],name);Files.createDirectories(output.getParent());Files.write(output,writer.toByteArray());
    }
}
