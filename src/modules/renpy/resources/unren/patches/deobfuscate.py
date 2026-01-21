from __future__ import annotations

import random


def _decrypt_inceton(data: bytes, count):
    try:
        key = 7251521812251191913112121616
        data_list = list(data)
        random.seed(key)
        shuffle_indices = list(range(len(data_list)))
        random.shuffle(shuffle_indices)
        reverse_indices = [0] * len(shuffle_indices)
        for i, shuffled_index in enumerate(shuffle_indices):
            reverse_indices[shuffled_index] = i
        return bytes([data_list[i] for i in reverse_indices])
    except Exception:
        return None


def apply_deobfuscate_patches(deobfuscate_module) -> None:
    if getattr(deobfuscate_module, "_unren_patched", False):
        return

    if _decrypt_inceton not in deobfuscate_module.DECRYPTORS:
        deobfuscate_module.decryptor(_decrypt_inceton)

    def read_ast(f, context):
        diagnosis = ["Attempting to deobfuscate file:"]

        raw_datas = set()

        for extractor in deobfuscate_module.EXTRACTORS:
            try:
                data = extractor(f, 1)
            except ValueError as e:
                diagnosis.append(
                    f"strategy {extractor.__name__} failed: {chr(10).join(e.args)}"
                )
            else:
                diagnosis.append(f"strategy {extractor.__name__} success")
                raw_datas.add(data)

        if not raw_datas:
            diagnosis.append("All strategies failed. Unable to extract data")
            raise ValueError("\n".join(diagnosis))

        if len(raw_datas) != 1:
            diagnosis.append("Strategies produced different results. Trying all options")

        for raw_data in raw_datas:
            try:
                data, stmts, detail = deobfuscate_module.try_decrypt_section(raw_data)
            except ValueError as e:
                diagnosis.append("\n".join(e.args))
            else:
                diagnosis.extend(detail)
                context.log("\n".join(diagnosis))
                return stmts

        diagnosis.append("All strategies failed. Unable to deobfuscate data")
        raise ValueError("\n".join(diagnosis))

    deobfuscate_module.read_ast = read_ast
    deobfuscate_module._unren_patched = True
