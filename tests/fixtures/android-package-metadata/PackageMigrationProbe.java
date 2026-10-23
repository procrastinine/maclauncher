package com.android.server.pm;

import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningDetails;
import java.io.File;
import java.nio.file.*;
import java.security.cert.CertificateFactory;
import java.util.*;
import maclauncher.android.framework.HostProcessIdentity;

public final class PackageMigrationProbe {
    private static HostPackageMigration.Installation entry(String name,int uid,String shared,
            SigningDetails signing,boolean installed,boolean enabled){
        return new HostPackageMigration.Installation(name,uid,shared,signing,
                new File("/data/app/"+name),false,installed,enabled,12000,15000);
    }
    private static void check(boolean value,String detail){if(!value)throw new AssertionError(detail);}
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Files.createDirectories(Path.of(args[1]));
        var bootstrap=Class.forName("maclauncher.android.RuntimeBootstrap").getDeclaredMethod("initialize",
                Path.class,Path.class,Path.class,Path.class,String.class,boolean.class,boolean.class,boolean.class);
        bootstrap.setAccessible(true);
        bootstrap.invoke(null,runtime,data,Files.createDirectories(data.resolve("files")),
                Files.createDirectories(data.resolve("cache")),"fixture.migration",false,false,false);
        HostProcessIdentity.configure(1000,Integer.parseInt(args[2]));
        var certificates=CertificateFactory.getInstance("X.509");
        SigningDetails signer;
        try(var input=Files.newInputStream(Path.of(args[3]))){signer=new SigningDetails(new Signature[]{
                new Signature(certificates.generateCertificate(input).getEncoded())},3);}
        // Upstream's in-memory test constructor still owns the real Settings,
        // PackageSetting, SharedUserSetting and AppIdSettingMap implementation.
        Settings owner=new Settings(Map.of());
        var retained=List.of(entry("example.retired",10000,null,SigningDetails.UNKNOWN,false,true),
                entry("example.first",10001,"example.shared",signer,true,false),
                entry("example.second",10001,"example.shared",signer,true,true));
        try(var migration=HostPackageMigration.begin(retained)){
            check(!HostPackageMigration.settingsRead(owner,false),"First-boot return changed");
            migration.requireApplied();
        }
        PackageSetting first=owner.getPackageLPr("example.first"),second=owner.getPackageLPr("example.second");
        check(first.getAppId()==10001&&second.getAppId()==10001,"Shared UID changed");
        check(owner.getSharedUserSettingLPr(first)==owner.getSharedUserSettingLPr(second),"Duplicate shared owner");
        check(!owner.getPackageLPr("example.retired").getInstalled(0),"Retired code became installed");
        check(first.getEnabled(0)==PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER,"Disabled package enabled");
        var next=new PackageSetting("example.next",null,new File("/data/app/example.next"),0,0,UUID.randomUUID());
        owner.registerAppIdLPw(next,false);
        check(next.getAppId()==10002,"Original allocator reused retained UID");
        first.setEnabled(PackageManager.COMPONENT_ENABLED_STATE_ENABLED,0,"settings");
        try(var migration=HostPackageMigration.begin(retained)){
            check(HostPackageMigration.settingsRead(owner,true),"Persisted-read return changed");
        }
        check(first.getEnabled(0)==PackageManager.COMPONENT_ENABLED_STATE_ENABLED,"Old launcher state replaced original state");
        try(var migration=HostPackageMigration.begin(List.of(entry("example.first",10003,"example.shared",signer,true,true)))){
            try{HostPackageMigration.settingsRead(owner,true);throw new AssertionError("Mismatched retained UID accepted");}
            catch(SecurityException expected){}
        }
        check(owner.getPackageLPr("example.first")==first&&first.getAppId()==10001,"Mismatch changed original record");
        check(HostPackageMigration.settingsRead(owner,true),"Closed migration retained state");
        System.out.println("PASS original Settings migration, retained IDs, shared owner, disabled state and restart authority");
        System.exit(0);
    }
}
