// Copyright (c) MacLauncher contributors. MIT license.
// Additive API over the original mpv BIND resolver. Apply only to an owned
// build tree of the declared source; the original Git checkout is read-only.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const PROFILE=JSON.parse(fs.readFileSync(new URL('./scene-profile.json',import.meta.url),'utf8'));
export const SOURCE=Object.freeze(PROFILE.SOURCE);
export const VULKAN_HEADERS=Object.freeze(PROFILE.VULKAN_HEADERS);
export const FAST_FLOAT=Object.freeze(PROFILE.FAST_FLOAT);
const originals={"src/shaders/custom_mpv.c":"0091602f4d94a5e23de05b560a43658c1cffcc50455012a323f23c814ef5a984","src/include/libplacebo/shaders/custom.h":"eb7c317f6c93ce76a67f5e622d5c784e702545752a88535a4eb577fdcc74e50e"};
const sha=value=>crypto.createHash("sha256").update(value).digest("hex");
function replaceOnce(source,before,after){if(source.split(before).length!==2)throw new Error("The pinned libplacebo overlay seam changed.");return source.replace(before,after);}
export function applySceneOverlay(directory){
  const values={};for(const [name,digest]of Object.entries(originals)){const value=fs.readFileSync(path.join(directory,name));if(sha(value)!==digest)throw new Error("The original libplacebo source changed: "+name);values[name]=value.toString("utf8");}
  let header=values["src/include/libplacebo/shaders/custom.h"];
  header=replaceOnce(header,"PL_API_END",`// Borrowed read-only resources for the original mpv BIND and size-expression
// resolver. The table, names and textures remain valid until cleared after the
// synchronous renderer call. No ownership or implicit color conversion occurs.
#define PL_MPV_EXTERNAL_TEXTURES_API 1
struct pl_mpv_external_tex {
    const char *name;
    pl_tex texture;
    pl_rect2df rect;
    struct pl_color_repr repr;
    struct pl_color_space color;
    int components;
};
PL_API unsigned pl_mpv_user_shader_external_textures_api(void);
PL_API bool pl_mpv_user_shader_set_external_textures(const struct pl_hook *hook,
    const struct pl_mpv_external_tex *textures, int count);

PL_API_END`);
  let source=values["src/shaders/custom_mpv.c"];
  source=replaceOnce(source,"        struct hook_pass pass = {",`        // Resolve only immutable numeric conditions during preparation. The
        // original evaluator preserves its float/RPN semantics; parameters
        // and image-size conditions remain live and retain their inputs.
        bool constant_cond = true;
        for (int i = 0; i < MAX_SHEXP_SIZE && h.cond[i].tag; i++) {
            if (h.cond[i].tag == SHEXP_VAR || h.cond[i].tag == SHEXP_TEX_W ||
                h.cond[i].tag == SHEXP_TEX_H)
                constant_cond = false;
        }
        struct hook_ctx preparation_ctx = {.priv = p};
        float constant_value;
        if (constant_cond && eval_shexpr(&preparation_ctx, h.cond, &constant_value) &&
            constant_value == 0.0f)
            continue;

        struct hook_pass pass = {`);
  source=replaceOnce(source,"    // Dynamic per pass\n",`    // Borrowed call-local image bindings; internal SAVE textures stay separate.
    const struct pl_mpv_external_tex *external_textures;
    int num_external_textures;

    // Dynamic per pass
`);
  source=replaceOnce(source,"    for (int i = 0; i < p->pass_textures.num; i++) {\n        if (pl_str_equals(var, p->pass_textures.elem[i].name)) {",`    for (int i = 0; i < p->num_external_textures; i++) {
        const struct pl_mpv_external_tex *tex = &p->external_textures[i];
        if (pl_str_equals0(var, tex->name)) {
            size[0] = fabs(pl_rect_w(tex->rect));
            size[1] = fabs(pl_rect_h(tex->rect));
            return true;
        }
    }

    for (int i = 0; i < p->pass_textures.num; i++) {
        if (pl_str_equals(var, p->pass_textures.elem[i].name)) {`);
  source=replaceOnce(source,"            for (int j = 0; j < p->descriptors.num; j++) {",`            for (int j = 0; j < p->num_external_textures; j++) {
                const struct pl_mpv_external_tex *external = &p->external_textures[j];
                if (pl_str_equals0(texname, external->name)) {
                    const struct pass_tex image = {
                        .name = pl_str0(external->name), .tex = external->texture,
                        .rect = external->rect, .repr = external->repr,
                        .color = external->color, .comps = external->components,
                    };
                    if (!bind_pass_tex(sh, texname, &image, &image.rect, false, false))
                        goto error;
                    goto next_bind;
                }
            }

            for (int j = 0; j < p->descriptors.num; j++) {`);
  source=replaceOnce(source,"const struct pl_hook *pl_mpv_user_shader_parse(pl_gpu gpu,",`unsigned pl_mpv_user_shader_external_textures_api(void)
{
    return PL_MPV_EXTERNAL_TEXTURES_API;
}

static bool external_expr_uses(const struct shexp expr[MAX_SHEXP_SIZE], const char *name)
{
    for (int i = 0; i < MAX_SHEXP_SIZE && expr[i].tag; i++) {
        if ((expr[i].tag == SHEXP_TEX_W || expr[i].tag == SHEXP_TEX_H) &&
            pl_str_equals0(expr[i].val.varname, name))
            return true;
    }
    return false;
}

bool pl_mpv_user_shader_set_external_textures(const struct pl_hook *hook,
    const struct pl_mpv_external_tex *textures, int count)
{
    if (!hook || hook->hook != hook_hook || hook->reset != hook_reset)
        return false;
    struct hook_priv *p = hook->priv;
    if (count < 0 || count > 128 || (count && !textures))
        return false;
    for (int i = 0; i < count; i++) {
        const struct pl_mpv_external_tex *t = &textures[i];
        if (!t->name || !t->name[0] || !t->texture ||
            !t->texture->params.sampleable || t->texture->params.d ||
            t->components < 1 || t->components > t->texture->params.format->num_components)
            goto invalid;
        for (int n = 0; t->name[n]; n++) {
            unsigned char c = t->name[n];
            if (n >= 512 || !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                c == '_' || (n && c >= '0' && c <= '9')))
                goto invalid;
        }
        const char *reserved[] = {"HOOKED", "NATIVE_CROPPED", "OUTPUT", "MAIN", "MAINPRESUB",
            "RGB", "LUMA", "CHROMA", "ALPHA", "XYZ", "CHROMA_SCALED", "ALPHA_SCALED",
            "NATIVE", "LINEAR", "SIGMOID", "PREKERNEL", "POSTKERNEL", "SCALED", "PREOUTPUT"};
        for (int n = 0; n < PL_ARRAY_SIZE(reserved); n++)
            if (strcmp(t->name, reserved[n]) == 0) goto invalid;
        const float bounds[] = {t->rect.x0, t->rect.y0, t->rect.x1, t->rect.y1};
        for (int n = 0; n < 4; n++)
            if (!isfinite(bounds[n]) || bounds[n] < 0 ||
                bounds[n] > (n % 2 ? t->texture->params.h : t->texture->params.w))
                goto invalid;
        if (!pl_rect_w(t->rect) || !pl_rect_h(t->rect)) goto invalid;
        for (int j = 0; j < i; j++)
            if (strcmp(t->name, textures[j].name) == 0) goto invalid;
        for (int j = 0; j < p->descriptors.num; j++)
            if (strcmp(t->name, p->descriptors.elem[j].desc.name) == 0) goto invalid;
        bool used = false;
        for (int j = 0; j < p->hook_passes.num; j++) {
            const struct custom_shader_hook *pass = &p->hook_passes.elem[j].hook;
            if (pl_str_equals0(pass->save_tex, t->name)) goto invalid;
            for (int k = 0; k < SHADER_MAX_BINDS; k++)
                used |= pl_str_equals0(pass->bind_tex[k], t->name);
            used |= external_expr_uses(pass->width, t->name) ||
                    external_expr_uses(pass->height, t->name) ||
                    external_expr_uses(pass->cond, t->name);
        }
        if (!used) goto invalid;
    }
    p->external_textures = textures;
    p->num_external_textures = count;
    return true;
invalid:
    PL_ERR(p, "Invalid, unused or writable external mpv texture binding");
    return false;
}

const struct pl_hook *pl_mpv_user_shader_parse(pl_gpu gpu,`);
  fs.writeFileSync(path.join(directory,"src/include/libplacebo/shaders/custom.h"),header);
  fs.writeFileSync(path.join(directory,"src/shaders/custom_mpv.c"),source);
  return {source:SOURCE,vulkanHeaders:VULKAN_HEADERS,files:Object.keys(originals).map(name=>({path:name,originalSha256:originals[name],sha256:sha(fs.readFileSync(path.join(directory,name)))}))};
}
