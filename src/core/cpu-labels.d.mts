export function cpuId(value: unknown): "x64" | "arm64" | "x86" | "universal" | "";
export function cpuLabel(value: unknown, options?: { windows?: boolean; hostArchitecture?: string | null }): string;
