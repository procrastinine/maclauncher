#include "windef.h"
#include "winbase.h"
#include "wine/unixlib.h"

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void *reserved)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        DisableThreadLibraryCalls(instance);
        return !__wine_init_unix_call();
    }
    return TRUE;
}
