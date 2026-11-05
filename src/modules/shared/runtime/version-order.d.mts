export function compareVersions(left: unknown, right: unknown): number;
export function catalogVersion(pin?: Record<string, unknown>): unknown;
export function newest<T>(items: Iterable<T>, options?: {
  listed?: Iterable<unknown>;
  versionOf?: (item: T) => unknown;
}): T | null;
