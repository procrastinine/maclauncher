#pragma once
/* Copyright (c) MacLauncher contributors. MIT license. */
#include <string.h>
#include "scene-metadata.h"
#include "macfx-shared/reshade/native/recorded-scene.h"

/* One unused logical-operation lease on the existing feature context. Its
 * caller serializes access. Recorded/submitted flights retain their own driver
 * references; clearing this slot never completes or abandons a GPU flight. */
struct scene_admission {
    uint64_t identity;
    RSWineVulkanSceneRequestV2 request;
    RSRecordedSceneConsumerV3 consumer;
};
static inline int scene_admission_valid(const RSRecordedSceneConsumerV3 *value)
{
    const RSVulkanSceneCallbacksV1 *cb = &value->callbacks.base;
    return value->size == sizeof(*value) && value->version == 3 && value->owner &&
        cb->size == sizeof(value->callbacks) && cb->version == 3 && cb->storage &&
        cb->retain && cb->release && cb->encode && cb->completed && value->callbacks.submitted;
}
static inline void scene_admission_clear(struct scene_admission *value)
{
    RSRecordedSceneConsumerV3 consumer = value->consumer;
    memset(value, 0, sizeof(*value));
    if (consumer.callbacks.base.release)
        consumer.callbacks.base.release(consumer.callbacks.base.storage);
}
/* Transfer exactly one reference returned by native preparation. There is no
 * caller-created token, guessed provider, or success inferred from recording. */
static inline int scene_admission_install(struct scene_admission *value, uint64_t identity,
    const RSWineVulkanSceneRequestV2 *request, RSRecordedSceneConsumerV3 *consumer,
    const RSTemporalResult *result)
{
    if (!identity || !request || request->base.flags || request->base.reserved[0] ||
        request->base.reserved[1] || request->base.consumerId != identity ||
        !result || result->size != sizeof(*result) || result->version != 1 ||
        result->status != RS_TEMPORAL_OK || result->encoded || !scene_admission_valid(consumer))
        return 0;
    scene_admission_clear(value);
    value->identity = identity; value->request = *request; value->consumer = *consumer;
    memset(consumer, 0, sizeof(*consumer));
    return 1;
}
static inline int scene_admission_matches(const struct scene_admission *value,
    const RSWineVulkanSceneRequestV2 *request)
{
    return value->identity && request && request->base.consumerId == value->identity &&
        !memcmp(&value->request, request, sizeof(*request));
}
