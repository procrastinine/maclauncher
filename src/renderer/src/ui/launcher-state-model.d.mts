import type { GameFailure } from "./types";

export function shareLauncherValue<T>(previous: T | null | undefined, incoming: T): T;
export function updatePathValue<T>(values: Record<string, T>, gamePath: string, value: T): Record<string, T>;
export function subscribeLauncherState<T>(api: {
  getState(): Promise<T>;
  onState(callback: (state: T) => void): () => void;
}, receive: (state: T) => void, fail: (error: any) => void): () => void;
export function subscribeLauncherGameFailures(api: {
  onGameFailed?(callback: (failure: GameFailure) => void): () => void;
} | undefined, receive: (message: string) => void): () => void;
export function createInspectionRequests(): {
  run<T>(gamePath: string, action: string, key: string, request: () => Promise<T>): Promise<{ current: boolean; value: T }>;
  invalidate(gamePath: string, action?: string): void;
  retain(gamePaths: string[]): void;
};

