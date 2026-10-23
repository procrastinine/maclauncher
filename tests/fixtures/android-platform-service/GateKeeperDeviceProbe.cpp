#include <AndroidKeyMintDevice.h>
#include <AndroidSharedSecret.h>
#include "GateKeeper.h"
#include "SharedSecret.h"
#include "SoftGateKeeper.h"
#include <cassert>
#include <cstdio>

int main() {
    namespace km = aidl::android::hardware::security::keymint;
    namespace ss = aidl::android::hardware::security::sharedsecret;
    namespace gk = aidl::android::hardware::gatekeeper;
    auto keymint = ndk::SharedRefBase::make<km::AndroidKeyMintDevice>(km::SecurityLevel::SOFTWARE);
    auto keysecret = ndk::SharedRefBase::make<ss::AndroidSharedSecret>(keymint);
    auto secret = ndk::SharedRefBase::make<ss::SoftSharedSecret>();
    ss::SharedSecretParameters first, second;
    assert(keysecret->getSharedSecretParameters(&first).isOk());
    assert(secret->getSharedSecretParameters(&second).isOk());
    std::vector<ss::SharedSecretParameters> participants{first, second};
    std::vector<uint8_t> keyCheck, gateCheck;
    assert(keysecret->computeSharedSecret(participants, &keyCheck).isOk());
    assert(secret->computeSharedSecret(participants, &gateCheck).isOk());
    assert(keyCheck.size() == 32 && keyCheck == gateCheck);
    gatekeeper::SoftGateKeeper implementation(*secret);
    auto device = ndk::SharedRefBase::make<gk::SoftGateKeeperDevice>(implementation);
    const std::vector<uint8_t> password{1, 4, 9, 16, 25};
    gk::GatekeeperEnrollResponse enrolled;
    assert(device->enroll(10, {}, {}, password, &enrolled).isOk());
    assert(enrolled.statusCode == gk::IGatekeeper::STATUS_OK);
    assert(!enrolled.data.empty());
    gk::GatekeeperVerifyResponse verified;
    assert(device->verify(10, 1234, enrolled.data, password, &verified).isOk());
    assert(verified.statusCode == gk::IGatekeeper::STATUS_OK);
    assert(verified.hardwareAuthToken.challenge == 1234);
    assert(verified.hardwareAuthToken.mac.size() == 32);
    assert(!device->verify(10, 1234, enrolled.data, {3, 2, 1}, &verified).isOk());
    // A fresh original software device verifies its persisted enrollment
    // handle without retaining a parallel credential database.
    gatekeeper::SoftGateKeeper restored(*secret);
    auto next = ndk::SharedRefBase::make<gk::SoftGateKeeperDevice>(restored);
    assert(next->verify(10, 5678, enrolled.data, password, &verified).isOk());
    assert(verified.hardwareAuthToken.challenge == 5678);
    std::puts("PASS original GateKeeper enrollment, token negotiation and retained handle");
}
