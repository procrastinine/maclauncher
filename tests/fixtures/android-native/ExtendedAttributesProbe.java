package libcore.io;
import java.nio.file.*;
import java.util.*;
import android.system.ErrnoException;
import maclauncher.android.framework.HostFilesystem;
public final class ExtendedAttributesProbe {
    interface Action{void run()throws Exception;}
    private static void check(boolean value){if(!value)throw new AssertionError();}
    private static void error(int code,Action action)throws Exception{try{action.run();throw new AssertionError("Missing errno "+code);}catch(ErrnoException expected){check(expected.errno==code);}}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]).toRealPath(),root=Path.of(args[1]).toRealPath(),file=root.resolve("attributes-α.bin");
        HostFilesystem.configure(runtime,root,root,root,"owned.attributes");System.load(args[2]);
        var os=new libcore.io.Linux();Files.write(file,new byte[]{7});String path=file.toString(),name="user.android-owner",empty="user.android-empty";
        byte[] value={0,1,-1,127,0};os.setxattr(path,name,value,1);check(Arrays.equals(value,os.getxattr(path,name)));
        error(17,()->os.setxattr(path,name,value,1));error(61,()->os.setxattr(path,"user.absent",value,2));
        byte[] large=new byte[8192];new Random(1).nextBytes(large);os.setxattr(path,name,large,2);check(Arrays.equals(large,os.getxattr(path,name)));
        os.setxattr(path,empty,new byte[0],0);check(os.getxattr(path,empty).length==0);
        check(Arrays.asList(os.listxattr(path)).containsAll(List.of(name,empty)));
        Path moved=root.resolve("moved");Files.move(file,moved);check(Arrays.equals(large,os.getxattr(moved.toString(),name)));
        os.removexattr(moved.toString(),name);error(61,()->os.getxattr(moved.toString(),name));os.removexattr(moved.toString(),empty);
        check(!Arrays.asList(os.listxattr(moved.toString())).contains(name));error(22,()->os.setxattr(moved.toString(),name,value,8));
        System.out.println("PASS original Linux xattr bytes, flags, listing, rename persistence and errno");
    }
}
