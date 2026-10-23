package maclauncher.android;
import java.nio.file.*;
import java.security.cert.CertificateFactory;
import android.content.pm.*;
import com.android.server.pm.HostPackageIdentities;
import org.json.*;

public final class PackageIdentityProbe {
    private static JSONObject request(String name,String shared,SigningDetails signing,boolean system)throws Exception {
        return new JSONObject().put("packageName",name).put("sharedUserId",shared).put("signing",HostPackageIdentities.signing(signing)).put("system",system);
    }
    private static void rejected(JSONObject assigned,JSONObject state,JSONObject request)throws Exception {
        try{HostPackageIdentities.allocate(assigned,state,new JSONArray().put(request));throw new AssertionError("Rejected package acquired an identity");}
        catch(com.android.server.pm.PackageManagerException|SecurityException expected){}
    }
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Files.createDirectories(Path.of(args[1]));
        RuntimeBootstrap.initialize(runtime,data,Files.createDirectories(data.resolve("files")),Files.createDirectories(data.resolve("cache")),"fixture.identities",false,false,false);
        var factory=CertificateFactory.getInstance("X.509");SigningDetails[] signing=new SigningDetails[2];
        for(int i=0;i<2;i++)try(var input=Files.newInputStream(Path.of(args[i+2]))){signing[i]=new SigningDetails(new Signature[]{new Signature(factory.generateCertificate(input).getEncoded())},3);}
        var first=request("example.first","example.shared",signing[0],false);
        JSONObject assigned=new JSONObject().put("example.legacy",10000),state=new JSONObject();
        var allocation=HostPackageIdentities.allocate(assigned,state,new JSONArray().put(first).put(request("example.second","example.shared",signing[0],false)));
        assigned=allocation.getJSONObject("identities");state=allocation.getJSONObject("packageIdentities");
        if(assigned.getInt("example.first")!=10001||assigned.getInt("example.second")!=10001||assigned.getInt("example.legacy")!=10000)throw new AssertionError("Original allocator did not preserve assignments and shared membership");
        var restarted=HostPackageIdentities.allocate(new JSONObject(assigned.toString()),new JSONObject(state.toString()),new JSONArray().put(first));
        if(restarted.getJSONObject("identities").getInt("example.first")!=10001)throw new AssertionError("Restart changed UID");
        rejected(assigned,state,request("example.foreign","example.shared",signing[1],false));
        rejected(assigned,state,request("example.first","example.shared",signing[1],false));
        rejected(assigned,state,request("example.untrusted","android.uid.system",signing[0],false));
        var trusted=HostPackageIdentities.allocate(assigned,state,new JSONArray().put(request("example.system","android.uid.system",signing[0],true)));
        if(trusted.getJSONObject("identities").getInt("example.system")!=android.os.Process.SYSTEM_UID)throw new AssertionError("Original fixed shared UID was not retained");
        rejected(trusted.getJSONObject("identities"),trusted.getJSONObject("packageIdentities"),request("example.bad.system","android.uid.system",signing[1],true));
        System.out.println("PASS original UID allocation, signed shared membership, updates and retained assignments");
        System.exit(0);
    }
}
