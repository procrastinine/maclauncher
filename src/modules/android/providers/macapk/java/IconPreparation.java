package com.maclauncher.android.macapk;

/** Uses the supplier's drawable/resource pipeline without loading game code. */
public final class IconPreparation {
    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Package and icon directory required");
        Class.forName("com.macapk.loader.Boot")
            .getMethod("extractIconOnly", String.class, String.class, String.class)
            .invoke(null, args[0], args[1], "");
        var icon = java.nio.file.Path.of(args[1], "icon.png");
        if (!java.nio.file.Files.isRegularFile(icon) || java.nio.file.Files.size(icon) == 0)
            throw new IllegalStateException("The package has no rendered application icon");
    }
}
