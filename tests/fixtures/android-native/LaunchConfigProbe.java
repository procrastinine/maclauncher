package maclauncher.android;
import java.nio.file.*;
import java.io.IOException;
import java.util.*;
public final class LaunchConfigProbe {
    static String quote(String text){return "\""+text.replace("\\","\\\\").replace("\"","\\\"")+"\"";}
    static String json(Map<String,Object> fields){return fields.entrySet().stream().map(e->quote(e.getKey())+":"+(e.getValue() instanceof String s?quote(s):e.getValue().toString())).collect(java.util.stream.Collectors.joining(",","{","}"));}
    static void reject(Path config,String value)throws Exception{Files.writeString(config,value);try{LaunchConfig.read(config);throw new AssertionError("Invalid config accepted: "+value);}catch(IOException expected){}}
    public static void main(String[] args)throws Exception{
        if(args.length>1){LaunchConfig original=LaunchConfig.read(Path.of(args[1]));if(!original.text("packageName").equals("example.game"))throw new AssertionError("Launcher wire data changed");}
        Path root=Files.createTempDirectory(Path.of(args[0]).toRealPath(),"host-config-");
        try {
            Path input=Files.writeString(root.resolve("app.jar"),"fixture"),config=root.resolve("launch.json");
            Map<String,Object> fields=new LinkedHashMap<>();fields.put("schemaVersion",1);fields.put("runtimeRoot",root.toString());fields.put("packageName","example.game");fields.put("versionName","1.0");fields.put("versionCode",1);fields.put("activityClass","example.game.Activity");fields.put("title","Unicode 遊戲 🦊");fields.put("width",512);fields.put("height",384);
            for(String name:List.of("nativeRoot","assetsRoot","resourcesRoot","filesRoot","cacheRoot"))fields.put(name,root.toString());
            fields.put("sourceApk",input.toString());fields.put("convertedJar",input.toString());
            String valid=json(fields);Files.writeString(config,valid);LaunchConfig parsed=LaunchConfig.read(config);if(!parsed.text("title").equals(fields.get("title"))||!parsed.file("convertedJar").equals(input))throw new AssertionError("Valid config changed");
            if(!parsed.touchJoystick().equals("wasd")||parsed.touchJoystickPosition("touchJoystickX",1800)!=.18f)throw new AssertionError("Default WASD touch controls changed");
            Files.writeString(config,valid.substring(0,valid.length()-1)+",\"touchJoystick\":\"wasd-arrows\",\"touchJoystickX\":1800,\"touchJoystickY\":7500,\"touchJoystickRadius\":1250}");
            var joystick=LaunchConfig.read(config);if(!joystick.touchJoystick().equals("wasd-arrows")||joystick.touchJoystickPosition("touchJoystickRadius",1200)!=.125f)throw new AssertionError("Normalized touch controls changed");
            for(String controls:List.of("\"keyboard\"","1","true"))reject(config,valid.substring(0,valid.length()-1)+",\"touchJoystick\":"+controls+"}");
            for(String position:List.of("-1","10001","1.5","\"1800\""))reject(config,valid.substring(0,valid.length()-1)+",\"touchJoystickX\":"+position+"}");
            for(String radius:List.of("0","5001"))reject(config,valid.substring(0,valid.length()-1)+",\"touchJoystickRadius\":"+radius+"}");
            if(parsed.webLinksAllowed()||parsed.networkAllowed()||parsed.allowAds()||parsed.googleProviderCompatibility()||parsed.inputUid("audioInputUid")!=null)throw new AssertionError("Missing optional policy enabled");
            for(String policy:List.of("webLinksAllowed","networkAllowed","allowAds","googleProviderCompatibility"))for(String value:List.of("-1","2","true","\"1\""))reject(config,valid.substring(0,valid.length()-1)+",\""+policy+"\":"+value+"}");
            Files.writeString(config,valid.substring(0,valid.length()-1)+",\"webLinksAllowed\":1,\"networkAllowed\":1,\"allowAds\":1,\"audioInputUid\":\"selected-device\",\"cameraInputUid\":\"\"}");
            var policies=LaunchConfig.read(config);if(!policies.webLinksAllowed()||!policies.networkAllowed()||!policies.allowAds()||!policies.inputUid("audioInputUid").equals("selected-device")||policies.inputUid("cameraInputUid")!=null)throw new AssertionError("Explicit policy lost");
            var artValues=new HashMap<String,Object>();artValues.put("audioInputUid","selected-device");artValues.put("cameraInputUid","");
            if(!ApplicationSettings.read(artValues::get).equals(policies.applicationSettings()))throw new AssertionError("Both VM readers must produce the same input settings");
            artValues.put("touchJoystick","wasd-arrows");artValues.put("touchJoystickX",1800);artValues.put("touchJoystickY",7500);artValues.put("touchJoystickRadius",1250);
            var artSettings=ApplicationSettings.read(artValues::get);
            if(!artSettings.touchJoystick().equals(joystick.touchJoystick())||artSettings.joystickRadius()!=joystick.touchJoystickPosition("touchJoystickRadius",1200))throw new AssertionError("Integer JSON input differs between VMs");
            artValues.put("touchJoystickX",1800.5);try{ApplicationSettings.read(artValues::get);throw new AssertionError("Fractional control position accepted");}catch(IOException expected){}
            reject(config,valid.substring(0,valid.length()-1)+",\"audioInputUid\":\""+"x".repeat(513)+"\"}");
            Map<String,Object> accountOwner=new LinkedHashMap<>(fields);accountOwner.remove("activityClass");accountOwner.put("serviceProcess",1);accountOwner.put("processName","example.game");accountOwner.put("authorityFd",5);accountOwner.put("accountControlFd",6);
            Files.writeString(config,json(accountOwner));if(!LaunchConfig.read(config).serviceProcess())throw new AssertionError("Account owner requires a service process");
            accountOwner.put("accountControlFd",5);reject(config,json(accountOwner));accountOwner.put("accountControlFd",6);
            if(!ApplicationSettings.read(accountOwner::get).touchJoystick().equals("off"))throw new AssertionError("Background service received game touch controls");
            accountOwner.put("serviceFd",6);reject(config,json(accountOwner));accountOwner.remove("serviceFd");
            accountOwner.remove("authorityFd");reject(config,json(accountOwner));
            reject(config,valid.substring(0,valid.length()-1)+",\"authorityFd\":5,\"accountControlFd\":6}");
            reject(config,valid.substring(0,valid.length()-1)+",\"width\":512}");
            reject(config,valid.replace("\"schemaVersion\":1","\"schemaVersion\":2"));
            reject(config,valid.replace("\"width\":512","\"width\":0512"));
            reject(config,valid.replace("\"width\":512","\"width\":512.0"));
            reject(config,valid.replace("\"width\":512","\"width\":9223372036854775808"));
            reject(config,valid.replace("\"width\":512","\"width\":63"));
            reject(config,valid.replace("\"height\":384","\"height\":8193"));
            Files.writeString(config,valid.replace("\"width\":512","\"width\":1024"));
            if(LaunchConfig.read(config).number("width")!=1024)throw new AssertionError("Configurable viewport was lost");
            reject(config,valid.replace("\"title\":"+quote((String)fields.get("title")),"\"title\":\"\\ud800\""));
            reject(config,valid.substring(0,valid.length()-1)+",\"javaArgs\":\"-javaagent:payload.jar\"}");
            reject(config,valid+" trailing");
            String full=valid+" ".repeat(LaunchConfig.MAX_BYTES-valid.getBytes(java.nio.charset.StandardCharsets.UTF_8).length-1)+"\n";
            Files.writeString(config,full);if(Files.size(config)!=LaunchConfig.MAX_BYTES||!LaunchConfig.read(config).text("title").equals(fields.get("title")))throw new AssertionError("Exact UTF-8 wire boundary failed");
            reject(config,full+" ");reject(config," ".repeat(LaunchConfig.MAX_BYTES+1));
            Files.write(config,new byte[]{(byte)0xc0,(byte)0xaf});try{LaunchConfig.read(config);throw new AssertionError("Invalid UTF8 accepted");}catch(IOException expected){}
            fields.put("nativeRoot","relative");reject(config,json(fields));fields.put("nativeRoot",root.toString());
            Files.writeString(config,valid);parsed=LaunchConfig.read(config);Path outside=Files.createTempFile(root.getParent(),"outside-",".dylib");try{Files.createSymbolicLink(root.resolve("escape"),outside);try{parsed.runtimeFile("escape");throw new AssertionError("External runtime symlink accepted");}catch(IOException expected){}}finally{Files.deleteIfExists(outside);}
            System.out.println("PASS Android launch config: Unicode/real paths, duplicate/unknown fields, numeric bounds, schema/dimensions, malformed strings and runtime containment; no native libraries or GPU loaded");
        } finally {try(var paths=Files.walk(root)){for(Path file:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(file);}}
    }
}
