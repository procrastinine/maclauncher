export declare const ACTIONS: Readonly<Record<"bypass" | "screenshot" | "windowGraphics" | "windowPointer", string>>;
export type ShortcutCheck = {ok: true; accelerator: string | null} | {ok: false; reason: string};
export declare function parse(accelerator: unknown): {modifiers: string[]; key: string; accelerator: string} | null;
export declare function electronAccelerator(accelerator: string): string | null;
export declare function validate(action: string, accelerator: unknown, assigned?: Record<string, string | null | undefined>): ShortcutCheck;
export declare function normalize(value: unknown): Record<string, string>;
export declare function fromKeyboardEvent(event: {code?: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean}): string | null;

export declare const ACTION_HELP: Readonly<Partial<Record<keyof typeof ACTIONS, string>>>;
