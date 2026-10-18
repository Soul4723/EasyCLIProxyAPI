import { useCallback, useEffect, useRef, useState } from 'react';

type FieldValue = string | boolean;

/**
 * Per-field drafts over a saved record. When `saved` changes (reload, config file change, save result) every field the user has
 * not edited adopts the new saved value; edited fields keep the draft. `dirty` lists the keys whose draft differs from `saved`.
 * String fields compare trimmed.
 */
export function useFieldDrafts<T extends Record<string, FieldValue>>(saved: T | null) {
  const [draft, setDraft] = useState<T | null>(saved);
  const previous = useRef<T | null>(saved);

  useEffect(() => {
    const before = previous.current;
    previous.current = saved;
    if (!saved) return;
    setDraft((current) => {
      if (!current || !before) return saved;
      const next = { ...current };
      for (const key of Object.keys(saved) as (keyof T)[]) {
        if (same(current[key], before[key])) next[key] = saved[key];
      }
      return next;
    });
  }, [saved]);

  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }, []);
  const reset = useCallback(() => setDraft(saved), [saved]);
  const dirty = (draft && saved ? (Object.keys(saved) as (keyof T & string)[]).filter((key) => !same(draft[key], saved[key])) : []);
  return { draft, set, reset, dirty };
}

const same = (a: FieldValue, b: FieldValue) => (typeof a === 'string' && typeof b === 'string' ? a.trim() === b.trim() : a === b);
