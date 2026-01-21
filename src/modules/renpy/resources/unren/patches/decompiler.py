from __future__ import annotations

import importlib
from typing import Optional, Tuple, Type

from ..profiles import DecompilerProfile


def _patched_reconstruct_arginfo(arginfo):
    if arginfo is None:
        return ""

    First = _import_decompiler_symbol("First")
    rv = ["("]
    sep = First("", ", ")

    has_starred = hasattr(arginfo, "starred_indexes") or not hasattr(arginfo, "extrapos")

    if has_starred:
        for i, (name, val) in enumerate(arginfo.arguments):
            rv.append(sep())
            if name is not None:
                rv.append(f"{name}=")
            elif i in getattr(arginfo, "starred_indexes", ()):
                rv.append("*")
            elif i in getattr(arginfo, "doublestarred_indexes", ()):
                rv.append("**")
            rv.append(val)
    else:
        for (name, val) in arginfo.arguments:
            rv.append(sep())
            if name is not None:
                rv.append(f"{name}=")
            rv.append(val)
        if arginfo.extrapos:
            rv.append(sep())
            rv.append(f"*{arginfo.extrapos}")
        if arginfo.extrakw:
            rv.append(sep())
            rv.append(f"**{arginfo.extrakw}")

    rv.append(")")
    return "".join(rv)


def _import_decompiler_symbol(name: str):
    module = importlib.import_module("decompiler.util")
    return getattr(module, name)


def _patch_util(decompiler_module) -> None:
    if getattr(decompiler_module, "_unren_util_patched", False):
        return

    util_module = importlib.import_module("decompiler.util")
    util_module.reconstruct_arginfo = _patched_reconstruct_arginfo
    decompiler_module.reconstruct_arginfo = _patched_reconstruct_arginfo
    decompiler_module._unren_util_patched = True


def _pyexpr_types(renpy_module) -> Tuple[Type, ...]:
    expr_types = [renpy_module.ast.PyExpr]
    astsupport = getattr(renpy_module, "astsupport", None)
    if astsupport and hasattr(astsupport, "PyExpr"):
        expr_types.append(astsupport.PyExpr)
    return tuple(expr_types)


def build_decompiler_class(
    decompiler_module,
    profile: DecompilerProfile,
    gideon_decompiler: Optional[object] = None,
):
    _patch_util(decompiler_module)

    base = decompiler_module.Decompiler
    renpy = decompiler_module.renpy
    dispatch = decompiler_module.Dispatcher()
    dispatch.update(base.dispatch)

    class PatchedDecompiler(base):
        dispatch = dispatch

    footer_lines = list(profile.footer_lines)

    def dump(self, ast):
        if self.options.translator:
            self.options.translator.translate_dialogue(ast)

        if self.options.init_offset and isinstance(ast, (tuple, list)):
            self.set_best_init_offset(ast)

        super(PatchedDecompiler, self).dump(ast, skip_indent_until_write=True)
        for m in self.blank_line_queue:
            m(None)

        if footer_lines:
            footer_text = "\n" + "\n".join(footer_lines) + "\n"
            self.write(footer_text)

        assert not self.missing_init, "A required init, init label, or translate block was missing"

    PatchedDecompiler.dump = dump

    if profile.legacy_return_suppression:
        def print_return(self, ast):
            if (ast.expression is None
                    and self.parent is None
                    and self.index + 1 == len(self.block)
                    and self.index
                    and ast.linenumber == self.block[self.index].linenumber):
                return

            self.advance_to_line(ast.linenumber)
            self.indent()
            self.write("return")

            if ast.expression is not None:
                self.write(f" {ast.expression}")

        PatchedDecompiler.print_return = print_return
        PatchedDecompiler.dispatch[renpy.ast.Return] = print_return

    if profile.legacy_else_detection:
        expr_types = _pyexpr_types(renpy)

        def print_if(self, ast):
            First = _import_decompiler_symbol("First")
            statement = First("if", "elif")

            for i, (condition, block) in enumerate(ast.entries):
                if (i + 1) == len(ast.entries) and not isinstance(condition, expr_types):
                    self.indent()
                    self.write("else:")
                else:
                    if hasattr(condition, "linenumber"):
                        self.advance_to_line(condition.linenumber)
                    self.indent()
                    self.write(f"{statement()} {condition}:")

                self.print_nodes(block, 1)

        PatchedDecompiler.print_if = print_if
        PatchedDecompiler.dispatch[renpy.ast.If] = print_if

        def print_menu_item(self, label, condition, block, arguments):
            string_escape = decompiler_module.string_escape
            self.indent()
            self.write(f"\"{string_escape(label)}\"")

            if arguments is not None:
                self.write(_patched_reconstruct_arginfo(arguments))

            if block is not None:
                if isinstance(condition, expr_types):
                    self.write(f" if {condition}")
                self.write(":")
                self.print_nodes(block, 1)

        PatchedDecompiler.print_menu_item = print_menu_item

    if profile.legacy_python_block:
        def print_python(self, ast, early=False):
            self.indent()

            code = ast.code.source
            indented = code and code[0] == " "

            if code and (indented or code[0] == "\n"):
                code = code if indented else code[1:]
                self.write("python")
                if early:
                    self.write(" early")
                if ast.hide:
                    self.write(" hide")
                if ast.store != "store":
                    self.write(" in ")
                    self.write(ast.store[6:])
                self.write(":")

                if indented:
                    self.write(f"\n{code}")
                else:
                    split_logical_lines = decompiler_module.split_logical_lines
                    with self.increase_indent():
                        self.write_lines(split_logical_lines(code))
            else:
                self.write(f"$ {code}")

        PatchedDecompiler.print_python = print_python
        PatchedDecompiler.dispatch[renpy.ast.Python] = print_python
        PatchedDecompiler.dispatch[renpy.ast.EarlyPython] = lambda self, ast: print_python(self, ast, early=True)

    if profile.legacy_lex:
        def print_userstatement(self, ast):
            self.indent()
            self.write(ast.line)
            if ast.block is not None:
                with self.increase_indent():
                    self.print_lex(ast.block)

        def print_lex(self, lex):
            for entry in lex:
                if len(entry) == 4:
                    file, linenumber, content, block = entry
                else:
                    file, linenumber, _indent, content, block = entry
                self.advance_to_line(linenumber)
                self.indent()
                self.write(content)
                if block:
                    self.print_lex(block)

        PatchedDecompiler.print_userstatement = print_userstatement
        PatchedDecompiler.print_lex = print_lex
        PatchedDecompiler.dispatch[renpy.ast.UserStatement] = print_userstatement

        def print_menu(self, ast):
            self.indent()
            self.write("menu")
            if self.label_inside_menu is not None:
                self.write(f" {self.label_inside_menu.name}")
                self.label_inside_menu = None

            if ast.arguments is not None:
                self.write(_patched_reconstruct_arginfo(ast.arguments))

            self.write(":")

            with self.increase_indent():
                if ast.with_ is not None:
                    self.indent()
                    self.write(f"with {ast.with_}")

                if ast.set is not None:
                    self.indent()
                    self.write(f"set {ast.set}")

                if ast.item_arguments is not None:
                    item_arguments = ast.item_arguments
                else:
                    item_arguments = [None] * len(ast.items)

                for (label, condition, block), arguments in zip(ast.items, item_arguments):
                    if self.options.translator:
                        label = self.options.translator.strings.get(label, label)

                    state = None
                    if isinstance(condition, str) and hasattr(condition, "linenumber"):
                        if (self.say_inside_menu is not None
                                and condition.linenumber > self.linenumber + 1):
                            self.print_say_inside_menu()
                        self.advance_to_line(condition.linenumber)
                    elif self.say_inside_menu is not None:
                        state = self.save_state()
                        self.most_lines_behind = self.last_lines_behind
                        self.print_say_inside_menu()

                    self.print_menu_item(label, condition, block, arguments)

                    if state is not None:
                        if self.most_lines_behind > state[7]:
                            self.rollback_state(state)
                            self.print_menu_item(label, condition, block, arguments)
                        else:
                            self.most_lines_behind = max(state[6], self.most_lines_behind)

        PatchedDecompiler.print_menu = print_menu
        PatchedDecompiler.dispatch[renpy.ast.Menu] = print_menu

    if profile.translate_say:
        def print_translate_say(self, ast):
            if ast.language:
                self.indent()
                self.write(f"translate {ast.language} {ast.identifier}:")
                with self.increase_indent():
                    self.indent()
                    self.write(decompiler_module.say_get_code(ast))
            else:
                self.print_say(ast)

        PatchedDecompiler.print_translate_say = print_translate_say
        PatchedDecompiler.dispatch[renpy.ast.TranslateSay] = print_translate_say

    if profile.screenlang_v1:
        def print_screen(self, ast):
            self.require_init()
            screen = ast.screen
            if (gideon_decompiler
                    and hasattr(renpy, "screenlang")
                    and isinstance(screen, renpy.screenlang.ScreenLangScreen)):
                screendecompiler = getattr(gideon_decompiler, "screendecompiler", None)
                if screendecompiler is None:
                    screendecompiler = importlib.import_module("unren_gideon.decompiler.screendecompiler")
                self.linenumber = screendecompiler.pprint(
                    self.out_file,
                    screen,
                    indent_level=self.indent_level,
                    linenumber=self.linenumber,
                    skip_indent_until_write=self.skip_indent_until_write,
                )
                self.skip_indent_until_write = False
                return
            super(PatchedDecompiler, self).print_screen(ast)

        PatchedDecompiler.print_screen = print_screen
        PatchedDecompiler.dispatch[renpy.ast.Screen] = print_screen

    return PatchedDecompiler
