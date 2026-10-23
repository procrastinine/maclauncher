package maclauncher.build;

import com.android.tools.smali.dexlib2.*;
import com.android.tools.smali.dexlib2.iface.*;
import com.android.tools.smali.dexlib2.rewriter.*;
import com.android.tools.smali.dexlib2.writer.io.MemoryDataStore;
import com.android.tools.smali.dexlib2.writer.pool.DexPool;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

/** Test-only whole-DEX preservation, with the declared body restored. */
public final class DexBodiesProbe {
    static byte[] canonical(DexFile dex)throws Exception {
        MemoryDataStore store=new MemoryDataStore();try{DexPool.writeTo(store,dex);return store.getData();}finally{store.close();}
    }
    static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception {
        Path before=Path.of(args[0]),after=Path.of(args[1]);var mappings=DexBodies.mappings(Path.of(args[2]));
        var original=DexFileFactory.loadDexContainer(before.toFile(),null);
        var changed=DexFileFactory.loadDexContainer(after.toFile(),null);
        check(original.getDexEntryNames().equals(changed.getDexEntryNames()),"DEX membership/order changed");
        int classes=0,hidden=0,replacements=0;
        for(String entry:original.getDexEntryNames()){
            DexFile source=original.getEntry(entry).getDexFile(),actual=changed.getEntry(entry).getDexFile();
            Map<String,Method> restored=new HashMap<>();
            for(ClassDef type:source.getClasses()){
                classes++;for(Field field:type.getFields())hidden+=field.getHiddenApiRestrictions().isEmpty()?0:1;
                for(Method method:type.getMethods()){
                    hidden+=method.getHiddenApiRestrictions().isEmpty()?0:1;
                    String key=DexBodies.key(method);if(mappings.containsKey(key)||!DexUiHooks.hooks(method).isEmpty())restored.put(key,method);
                }
            }
            for(ClassDef type:actual.getClasses())for(Method method:type.getMethods()){
                String key=DexBodies.key(method);if(!restored.containsKey(key))continue;
                Method old=restored.get(key);check(old.getAccessFlags()==method.getAccessFlags(),"Method access changed");
                check(old.getHiddenApiRestrictions().equals(method.getHiddenApiRestrictions()),"Hidden API flags changed");
                check(old.getAnnotations().equals(method.getAnnotations()),"Method annotations changed");
                if(mappings.containsKey(key)){
                    List<Object> body=new ArrayList<>();method.getImplementation().getInstructions().forEach(body::add);
                    check(body.size()==3,"Expected delegate/result/return");replacements++;
                }
            }
            if(!restored.isEmpty()){
                DexRewriter rewriter=new DexRewriter(new RewriterModule(){
                    @Override public Rewriter<Method> getMethodRewriter(Rewriters rewriters){return method->restored.getOrDefault(DexBodies.key(method),method);}
                    @Override public Rewriter<ClassDef> getClassDefRewriter(Rewriters rewriters){
                        var original=super.getClassDefRewriter(rewriters);return type->{ClassDef value=original.rewrite(type);String descriptor=value.getType();
                            if(restored.values().stream().noneMatch(method->method.getDefiningClass().equals(descriptor)))return value;
                            value=com.android.tools.smali.dexlib2.immutable.ImmutableClassDef.of(value);
                            List<Method> methods=new ArrayList<>();for(Method method:value.getMethods())if(!method.getName().startsWith("$maclauncher$ui$"))methods.add(method);
                            return new com.android.tools.smali.dexlib2.immutable.ImmutableClassDef(value.getType(),value.getAccessFlags(),value.getSuperclass(),value.getInterfaces(),value.getSourceFile(),value.getAnnotations(),value.getFields(),methods);
                        };
                    }
                });
                check(Arrays.equals(canonical(source),canonical(rewriter.getDexFileRewriter().rewrite(actual))),"Original DEX behavior/metadata changed outside the declared method body: "+entry);
            }
        }
        try(ZipFile input=new ZipFile(before.toFile());ZipFile output=new ZipFile(after.toFile())){
            var entries=input.entries();List<String> names=new ArrayList<>();while(entries.hasMoreElements())names.add(entries.nextElement().getName());
            List<String> outputNames=new ArrayList<>();output.entries().asIterator().forEachRemaining(entry->outputNames.add(entry.getName()));check(names.equals(outputNames),"Archive membership/order changed");
            for(String name:names)if(!name.endsWith(".dex"))check(Arrays.equals(input.getInputStream(input.getEntry(name)).readAllBytes(),output.getInputStream(output.getEntry(name)).readAllBytes()),"Resource changed: "+name);
        }
        check(replacements==mappings.size(),"Wrong delegation count");check(hidden>0,"Input has no hidden-API metadata");
        System.out.println("Preserved "+classes+" original classes and "+hidden+" hidden-API members; delegated "+replacements+" body");
    }
}
