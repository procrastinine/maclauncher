import java.nio.file.*;
import org.objectweb.asm.*;

/** Adds a test observer to the existing system owner; no privileged app enrollment. */
public final class ProfileUidBindings {
    public static void main(String[] args)throws Exception {
        Path file=Path.of(args[0],"maclauncher/android/framework/HostProcessInfo.class");
        var writer=new ClassWriter(ClassWriter.COMPUTE_MAXS);
        new ClassReader(Files.readAllBytes(file)).accept(new ClassVisitor(Opcodes.ASM9,writer){
            @Override public MethodVisitor visitMethod(int access,String name,String descriptor,String signature,String[] exceptions){
                MethodVisitor target=super.visitMethod(access,name,descriptor,signature,exceptions);
                if(!name.equals("<init>"))return target;
                return new MethodVisitor(Opcodes.ASM9,target){
                    @Override public void visitInsn(int opcode){
                        if(opcode==Opcodes.RETURN){super.visitVarInsn(Opcodes.ALOAD,1);super.visitMethodInsn(Opcodes.INVOKESTATIC,"maclauncher/android/ProfileUidObserver","install","(Landroid/content/Context;)V",false);}
                        super.visitInsn(opcode);
                    }
                };
            }
        },0);
        Files.write(file,writer.toByteArray());
    }
}
