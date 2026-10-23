import java.nio.file.*;import java.util.*;import android.database.sqlite.*;import android.database.*;import android.content.res.*;import maclauncher.android.framework.*;
/** Original AOSP database state, publisher SQLite, and actual private filesystem calls. */
public final class NativeDatabaseProbe {
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),root=Path.of(args[1]);Files.createDirectories(root.resolve("files"));Files.createDirectories(root.resolve("cache"));
  HostFilesystem.configure(runtime,root,root.resolve("files"),root.resolve("cache"),"owned.sqlite");
  System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
  System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());
  JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
  AssetManager.createSystemAssetsInZygoteLocked(false,runtime.resolve("android-framework.jar").toString());
  var stats=android.system.Os.statvfs("/data");if(stats.f_frsize<=0||stats.f_blocks<=0)throw new AssertionError("filesystem statistics");
  Files.writeString(root.resolve("files/fd"),"owned");
  try(var input=new java.io.FileInputStream(root.resolve("files/fd").toFile())){var fd=android.system.Os.fstatvfs(input.getFD());if(fd.f_blocks!=stats.f_blocks)throw new AssertionError("descriptor filesystem");}
  try{android.system.Os.statvfs(root.resolve("absent").toString());throw new AssertionError();}catch(android.system.ErrnoException expected){if(expected.errno!=2||!expected.getMessage().contains("ENOENT"))throw expected;}
  android.system.Os.setenv("MACLAUNCHER_SQLITE_FIXTURE","emoji 🧩",true);if(!android.system.Os.getenv("MACLAUNCHER_SQLITE_FIXTURE").equals("emoji 🧩"))throw new AssertionError();android.system.Os.unsetenv("MACLAUNCHER_SQLITE_FIXTURE");
  try(SQLiteDatabase db=SQLiteDatabase.openOrCreateDatabase(root.resolve("owned.sqlite").toFile(),null)){
   db.execSQL("CREATE TABLE data (id INTEGER PRIMARY KEY, label TEXT, bytes BLOB)");
   try(var statement=db.compileStatement("INSERT INTO data VALUES (?,?,?)")){statement.bindLong(1,7);statement.bindString(2,"hello 🧩");statement.bindBlob(3,new byte[]{1,2,3});if(statement.executeInsert()!=7)throw new AssertionError();}
   db.beginTransaction();try{db.execSQL("INSERT INTO data VALUES (8,'rollback',NULL)");}finally{db.endTransaction();}
   try(var rows=db.rawQuery("SELECT * FROM data",null)){if(rows.getCount()!=1||!rows.moveToFirst()||rows.getLong(0)!=7||!rows.getString(1).equals("hello 🧩")||rows.getBlob(2)[2]!=3)throw new AssertionError();}
   if(!db.enableWriteAheadLogging())throw new AssertionError("WAL");
   db.beginTransactionNonExclusive();try{db.execSQL("INSERT INTO data VALUES (9,'commit',NULL)");db.setTransactionSuccessful();}finally{db.endTransaction();}
  }
  try(SQLiteDatabase db=SQLiteDatabase.openDatabase(root.resolve("owned.sqlite").toString(),null,SQLiteDatabase.OPEN_READONLY);var count=db.compileStatement("SELECT count(*) FROM data")){if(count.simpleQueryForLong()!=2)throw new AssertionError();}
  System.out.println("PASS raw SQLite transaction/query/blob/rollback/WAL/reopen/close and actual mapped filesystem statistics");
 }
}
