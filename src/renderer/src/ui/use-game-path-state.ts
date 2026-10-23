import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { retainPathValues } from "./launcher-state-model.mjs";

// Tool responses may arrive after an entry was removed in another window.
// Both library changes and late responses must release those entries.
export function useGamePathState<T>(gamePaths: ReadonlySet<string>): [Record<string, T>, Dispatch<SetStateAction<Record<string, T>>>] {
  const currentPaths = useRef(gamePaths);
  currentPaths.current = gamePaths;
  const [values, setValues] = useState<Record<string, T>>({});
  useEffect(() => { setValues(previous => retainPathValues(previous, gamePaths)); }, [gamePaths]);
  const update = useCallback<Dispatch<SetStateAction<Record<string, T>>>>(change => {
    setValues(previous => retainPathValues(typeof change === "function" ? change(previous) : change, currentPaths.current));
  }, []);
  return [values, update];
}
