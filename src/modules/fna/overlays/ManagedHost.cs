using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Loader;
using System.Threading.Tasks;

// The host runs in a separate native process. Game assemblies and framework
// substitutions are staged by the Node backend after an explicit preparation.
internal static class ManagedHost
{
    private static string gameRoot = "";
    private static string runtimeRoot = "";

    private static IntPtr ResolveNative(string name, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (name.Contains('/') || name.Contains('\\')) return IntPtr.Zero;
        string stem = name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) ? name.Substring(0, name.Length - 4) : name;
        // Prefer the ABI soname also linked by FNA3D/FAudio. Distributions can
        // contain regular-file aliases; loading both SDL names would create two
        // independent SDL instances (and duplicate Objective-C classes on macOS).
        foreach (string candidate in new[] { stem, "lib" + stem + ".0.dylib", "lib" + stem + ".dylib" })
        {
            string file = Path.Combine(runtimeRoot, "native", "lib", candidate);
            if (File.Exists(file)) return NativeLibrary.Load(file);
        }
        return IntPtr.Zero;
    }

    private static Assembly? ResolveAssembly(AssemblyLoadContext context, AssemblyName name)
    {
        if (String.IsNullOrEmpty(name.Name) || name.Name.Contains('/') || name.Name.Contains('\\')) return null;
        string file = Path.Combine(gameRoot, name.Name + ".dll");
        if (!File.Exists(file) && name.Name.StartsWith("Microsoft.Xna.Framework", StringComparison.Ordinal))
            file = Path.Combine(runtimeRoot, "abi", name.Name + ".dll");
        if (!File.Exists(file)) return null;
        Assembly loaded = context.LoadFromAssemblyPath(file);
        NativeLibrary.SetDllImportResolver(loaded, ResolveNative);
        return loaded;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length < 2) throw new ArgumentException("FNA host requires a staged game assembly and runtime directory.");
            string gameFile = Path.GetFullPath(args[0]);
            gameRoot = Path.GetDirectoryName(gameFile)!;
            runtimeRoot = Path.GetFullPath(args[1]);
            Directory.SetCurrentDirectory(gameRoot);
            AppContext.SetData("APP_CONTEXT_BASE_DIRECTORY", gameRoot + Path.DirectorySeparatorChar);
            AssemblyLoadContext.Default.Resolving += ResolveAssembly;
            AssemblyLoadContext.Default.ResolvingUnmanagedDll += (assembly, name) => ResolveNative(name, assembly, null);
            // The CLR can find FNA beside the host without raising Resolving.
            // Preload that selected/private framework so its P/Invoke bindings
            // always resolve against the reviewed native dependency directory.
            string frameworkFile = Path.Combine(gameRoot, "FNA.dll");
            if (File.Exists(frameworkFile)) {
                Assembly framework = AssemblyLoadContext.Default.LoadFromAssemblyPath(frameworkFile);
                NativeLibrary.SetDllImportResolver(framework, ResolveNative);
            }
            Assembly game = AssemblyLoadContext.Default.LoadFromAssemblyPath(gameFile);
            NativeLibrary.SetDllImportResolver(game, ResolveNative);
            MethodInfo entry = game.EntryPoint ?? throw new InvalidOperationException("Game assembly has no managed entry point.");
            Console.WriteLine("[maclauncher-fna] Game " + game.GetName().Name + " " + game.GetName().Version);
            Console.WriteLine("[maclauncher-fna] Host .NET " + Environment.Version + " " + RuntimeInformation.ProcessArchitecture);
            object? result = entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { args.Skip(2).ToArray() });
            if (result is Task<int> exit) return exit.GetAwaiter().GetResult();
            if (result is Task task) { task.GetAwaiter().GetResult(); return 0; }
            return result is int code ? code : 0;
        }
        catch (Exception error)
        {
            Exception failure = error is TargetInvocationException && error.InnerException != null ? error.InnerException : error;
            Console.Error.WriteLine("[maclauncher-fna] " + failure);
            return 1;
        }
    }
}
