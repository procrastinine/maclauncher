from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Tuple, Type

from ..vendor import import_unrpyc_renpycompat


class RScriptArguments(dict):
    __module__ = "store"

    @staticmethod
    def _is_num(value: str) -> bool:
        if "_" in value:
            return False
        try:
            int(value)
            return True
        except ValueError:
            return False

    def __getattr__(self, name):
        if name not in self:
            raise AttributeError(f"RScript argument {name} not defined.")

        value = self[name]
        if isinstance(value, (int, float)):
            return value

        if isinstance(value, str) and self._is_num(value):
            return int(value, 10)

        try:
            if isinstance(value, str) and value.startswith("engine.rscript."):
                value = value[len("engine.rscript."):]
            return eval(value)
        except Exception:
            return value

    def __setattr__(self, name, value):
        self[name] = value

    def __delattr__(self, name):
        if name not in self:
            raise AttributeError(f"RScript argument {name} not defined.")
        del self[name]


class RScriptArgumentsEngine(RScriptArguments):
    __module__ = "store.engine.rscript"


class KirikiriStorage(dict):
    __module__ = "store.engine.krkr"

    def __getattr__(self, name):
        if name not in self:
            raise AttributeError(f"Kirikiri argument {name} not defined.")
        return self[name]

    def __setattr__(self, name, value):
        self[name] = value

    def __delattr__(self, name):
        if name not in self:
            raise AttributeError(f"Kirikiri argument {name} not defined.")
        del self[name]

    def __add__(self, args):
        merged = KirikiriStorage()
        merged.update(self)
        merged.update(args)
        return merged


@dataclass(frozen=True)
class ExtraClass:
    cls: Type
    module: str


_EXTRA_CLASSES = [
    ExtraClass(RScriptArguments, "store"),
    ExtraClass(RScriptArgumentsEngine, "store.engine.rscript"),
    ExtraClass(KirikiriStorage, "store.engine.krkr"),
]


class PyExprSupportMixin:
    pass


def _build_pyexpr_support(renpycompat_module):
    class PyExprSupport(renpycompat_module.magic.FakeStrict, str, PyExprSupportMixin):
        __module__ = "renpy.astsupport"

        def __new__(cls, s, filename, linenumber, py=None, hashcode=None, column=None):
            self = str.__new__(cls, s)
            self.filename = filename
            self.linenumber = linenumber
            self.py = py
            self.hashcode = hashcode
            self.column = column
            return self

        def __getnewargs__(self):
            if self.column is not None:
                return str(self), self.filename, self.linenumber, self.py, self.hashcode, self.column
            if self.hashcode is not None:
                return str(self), self.filename, self.linenumber, self.py, self.hashcode
            if self.py is not None:
                return str(self), self.filename, self.linenumber, self.py
            return str(self), self.filename, self.linenumber

    return PyExprSupport


def _build_grouped_line(renpycompat_module):
    class GroupedLine(renpycompat_module.magic.FakeStrict, tuple):
        __module__ = "renpy.lexer"

        def __new__(cls, filename, number, indent, text, block):
            return tuple.__new__(cls, (filename, number, indent, text, block))

    return GroupedLine


def _patch_pycode(renpycompat_module) -> None:
    candidates = []
    pycode = getattr(renpycompat_module, "PyCode", None)
    if isinstance(pycode, type):
        candidates.append(pycode)
    special = getattr(renpycompat_module, "SPECIAL_CLASSES", None)
    if special:
        for cls in special:
            if isinstance(cls, type) and cls.__name__ == "PyCode":
                candidates.append(cls)

    if not candidates:
        return

    def __setstate__(self, state):
        if len(state) == 4:
            (_, self.source, self.location, self.mode) = state
            self.py = None
            self.hashcode = None
            self.col_offset = None
        elif len(state) == 5:
            (_, self.source, self.location, self.mode, self.py) = state
            self.hashcode = None
            self.col_offset = None
        elif len(state) == 6:
            (_, self.source, self.location, self.mode, self.py, self.hashcode) = state
            self.col_offset = None
        else:
            (_, self.source, self.location, self.mode, self.py, self.hashcode, self.col_offset) = state
        self.bytecode = None

    for pycode in candidates:
        if getattr(pycode, "_unren_patched", False):
            continue
        pycode.__setstate__ = __setstate__
        pycode._unren_patched = True


def _build_ast_prototypes(renpycompat_module) -> Iterable[Type]:
    FakeStrict = renpycompat_module.magic.FakeStrict

    class Say(FakeStrict):
        __module__ = "renpy.ast"

        who = None
        with_ = None
        interact = True
        attributes = None
        arguments = None
        temporary_attributes = None
        identifier = None
        explicit_identifier = None

    class Init(FakeStrict):
        __module__ = "renpy.ast"

        priority = 0

    class Label(FakeStrict):
        __module__ = "renpy.ast"

        translation_relevant = True
        parameters = None
        hide = False

        @property
        def name(self):
            if "name" in self.__dict__:
                return self.__dict__["name"]
            return self._name

    class Python(FakeStrict):
        __module__ = "renpy.ast"

        store = "store"
        hide = False

    class EarlyPython(FakeStrict):
        __module__ = "renpy.ast"

        store = "store"
        hide = False

    class Image(FakeStrict):
        __module__ = "renpy.ast"

        code = None
        atl = None

    class Transform(FakeStrict):
        __module__ = "renpy.ast"

        parameters = None
        store = "store"

    class Show(FakeStrict):
        __module__ = "renpy.ast"

        atl = None
        warp = True

    class ShowLayer(FakeStrict):
        __module__ = "renpy.ast"

        atl = None
        warp = True
        layer = "master"

    class Camera(FakeStrict):
        __module__ = "renpy.ast"

        atl = None
        warp = True
        layer = "master"

    class Scene(FakeStrict):
        __module__ = "renpy.ast"

        imspec = None
        atl = None
        warp = True
        layer = "master"

    class Hide(FakeStrict):
        __module__ = "renpy.ast"

        warp = True

    class With(FakeStrict):
        __module__ = "renpy.ast"

        paired = None

    class Call(FakeStrict):
        __module__ = "renpy.ast"

        arguments = None
        expression = False
        global_label = ""

    class Return(FakeStrict):
        __module__ = "renpy.ast"

        expression = None

    class Menu(FakeStrict):
        __module__ = "renpy.ast"

        translation_relevant = True
        set = None
        with_ = None
        has_caption = False
        arguments = None
        item_arguments = None
        rollback = "force"

    class Jump(FakeStrict):
        __module__ = "renpy.ast"

        expression = False
        global_label = ""

    class UserStatement(FakeStrict):
        __module__ = "renpy.ast"

        block = []
        translatable = False
        code_block = None
        translation_relevant = False
        rollback = "normal"
        subparses = []
        init_priority = 0
        atl = None

    class Define(FakeStrict):
        __module__ = "renpy.ast"

        store = "store"
        operator = "="
        index = None

    class Default(FakeStrict):
        __module__ = "renpy.ast"

        store = "store"

    class Style(FakeStrict):
        __module__ = "renpy.ast"

        parent = None
        clear = False
        take = None
        variant = None

    class Translate(FakeStrict):
        __module__ = "renpy.ast"

        rollback = "never"
        translation_relevant = True
        alternate = None
        language = None
        after = None

    class TranslateSay(FakeStrict):
        __module__ = "renpy.ast"

        translatable = True
        translation_relevant = True
        alternate = None
        language = None
        who = None
        with_ = None
        interact = True
        attributes = None
        arguments = None
        temporary_attributes = None
        identifier = None
        explicit_identifier = None

    class EndTranslate(FakeStrict):
        __module__ = "renpy.ast"

        rollback = "never"

    class TranslateString(FakeStrict):
        __module__ = "renpy.ast"

        translation_relevant = True
        language = None

    class TranslatePython(FakeStrict):
        __module__ = "renpy.ast"

        translation_relevant = True

    class TranslateBlock(FakeStrict):
        __module__ = "renpy.ast"

        translation_relevant = True
        language = None

    class TranslateEarlyBlock(FakeStrict):
        __module__ = "renpy.ast"

        translation_relevant = True
        language = None

    return [
        Say,
        Init,
        Label,
        Python,
        EarlyPython,
        Image,
        Transform,
        Show,
        ShowLayer,
        Camera,
        Scene,
        Hide,
        With,
        Call,
        Return,
        Menu,
        Jump,
        UserStatement,
        Define,
        Default,
        Style,
        Translate,
        TranslateSay,
        EndTranslate,
        TranslateString,
        TranslatePython,
        TranslateBlock,
        TranslateEarlyBlock,
    ]


def _unique_key(cls: Type) -> Tuple[str, str]:
    return (getattr(cls, "__module__", ""), getattr(cls, "__name__", ""))


def extend_class_factory_module(renpycompat) -> None:
    if getattr(renpycompat, "_unren_patched", False):
        return

    extra_classes: List[Type] = []

    _patch_pycode(renpycompat)

    pyexpr_support = _build_pyexpr_support(renpycompat)
    extra_classes.append(pyexpr_support)

    grouped_line = _build_grouped_line(renpycompat)
    extra_classes.append(grouped_line)

    extra_classes.extend(list(_build_ast_prototypes(renpycompat)))

    for extra in _EXTRA_CLASSES:
        extra_classes.append(extra.cls)

    existing = {_unique_key(cls) for cls in renpycompat.SPECIAL_CLASSES}
    for cls in extra_classes:
        if _unique_key(cls) in existing:
            continue
        renpycompat.SPECIAL_CLASSES.append(cls)
        existing.add(_unique_key(cls))

    renpycompat.CLASS_FACTORY = renpycompat.magic.FakeClassFactory(
        renpycompat.SPECIAL_CLASSES,
        renpycompat.magic.FakeStrict,
    )

    renpycompat._unren_patched = True


def extend_class_factory() -> None:
    renpycompat = import_unrpyc_renpycompat()
    extend_class_factory_module(renpycompat)
