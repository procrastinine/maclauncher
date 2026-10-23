// SPDX-License-Identifier: MIT
// Independent reject-only loader ABI. No ticket parser, key material or SDK input.
#include <cstdint>
#include <cstring>
#define API extern "C" __attribute__((visibility("default")))
using u32=std::uint32_t;using u64=std::uint64_t;
API bool SteamEncryptedAppTicket_BDecryptTicket(const void *,u32,void *,u32 *outputBytes,const void *,int) {
    if(outputBytes)*outputBytes=0;
    return false;
}
API bool SteamEncryptedAppTicket_BIsTicketForApp(const void *,u32,u32) {return false;}
API u32 SteamEncryptedAppTicket_GetTicketAppID(const void *,u32) {return 0;}
API u32 SteamEncryptedAppTicket_GetTicketIssueTime(const void *,u32) {return 0;}
API void SteamEncryptedAppTicket_GetTicketSteamID(const void *,u32,void *output) {
    if(output){const u64 invalid=0;std::memcpy(output,&invalid,sizeof(invalid));}
}
API const char *MacLauncher_EncryptedTicketABI_Version() {return "maclauncher-ticket-unavailable-0.1.0-universal";}
