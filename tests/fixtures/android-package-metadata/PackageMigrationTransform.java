import java.nio.file.*;
import java.util.jar.JarFile;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

public final class PackageMigrationTransform {
    public static void main(String[] args)throws Exception {
        String name="com/android/server/pm/Settings.class";
        try(var jar=new JarFile(args[0])){
            byte[] original=jar.getInputStream(jar.getJarEntry(name)).readAllBytes();
            byte[] changed=ServicePortability.transform(name,original);
            ClassNode before=new ClassNode(),after=new ClassNode();
            new ClassReader(original).accept(before,0);new ClassReader(changed).accept(after,0);
            if(before.methods.size()!=after.methods.size()||before.fields.size()!=after.fields.size())throw new AssertionError("Original API changed");
            int returns=0,hooks=0;
            for(MethodNode method:after.methods)for(AbstractInsnNode instruction:method.instructions){
                if(method.name.equals("readLPw")&&instruction.getOpcode()==Opcodes.IRETURN)returns++;
                if(instruction instanceof MethodInsnNode call&&call.owner.equals("com/android/server/pm/HostPackageMigration")){
                    if(!method.name.equals("readLPw")||!call.name.equals("settingsRead"))throw new AssertionError("Migration outside original read");
                    hooks++;
                }
            }
            if(returns==0||returns!=hooks)throw new AssertionError("Original Settings return boundary changed");
            Path target=Path.of(args[1]).resolve(name);Files.createDirectories(target.getParent());Files.write(target,changed);
            String injector="com/android/server/accounts/AccountManagerService$Injector.class";
            byte[] accountOriginal=jar.getInputStream(jar.getJarEntry(injector)).readAllBytes();
            byte[] accountChanged=ServicePortability.transform(injector,accountOriginal);
            ClassNode accountBefore=new ClassNode(),accountAfter=new ClassNode();
            new ClassReader(accountOriginal).accept(accountBefore,0);new ClassReader(accountChanged).accept(accountAfter,0);
            if(accountBefore.methods.size()!=accountAfter.methods.size()||accountBefore.fields.size()!=accountAfter.fields.size())throw new AssertionError("Original account API changed");
            int accountRoots=0,migrationRoots=0;
            for(MethodNode method:accountAfter.methods)for(AbstractInsnNode instruction:method.instructions){
                if(!(instruction instanceof MethodInsnNode call)||!call.owner.equals("android/os/Environment")||
                        !Type.getReturnType(call.desc).equals(Type.getType(java.io.File.class)))continue;
                if(!(call.getNext() instanceof MethodInsnNode hook)||!hook.owner.equals("maclauncher/android/framework/HostAccounts")||
                        !hook.name.equals("storageDirectory")||!hook.desc.equals("(Ljava/io/File;)Ljava/io/File;"))
                    throw new AssertionError("Account directory bypasses retained storage");
                accountRoots++;if(method.name.equals("getPreNDatabaseName"))migrationRoots++;
            }
            if(accountRoots<5||migrationRoots!=3)throw new AssertionError("Original account migration directories changed");
            // Removing only the inserted calls must reproduce the complete
            // original instruction stream, including pre-N rename/mkdir work.
            for(MethodNode method:accountAfter.methods)for(AbstractInsnNode instruction:method.instructions.toArray())
                if(instruction instanceof MethodInsnNode call&&call.owner.equals("maclauncher/android/framework/HostAccounts"))method.instructions.remove(call);
            ClassWriter first=new ClassWriter(ClassWriter.COMPUTE_MAXS),second=new ClassWriter(ClassWriter.COMPUTE_MAXS);
            accountBefore.accept(first);accountAfter.accept(second);
            if(!java.util.Arrays.equals(first.toByteArray(),second.toByteArray()))throw new AssertionError("Original account storage algorithm changed");
        }
    }
}
