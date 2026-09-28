// One Idempotency-Key per user action (docs/decisions.md D-2a-4).
//
// A key is created when the user starts an action (a cart, a form, "receive this transfer") and is
// reused for every submit of that same action — a double click, a retry after a network error, the
// automatic retry after a password re-confirmation — so the server creates the record at most once.
// It is replaced only after the action succeeded, so the next sale gets a new key.

import { useMemo, useRef } from 'react';
import { newActionKey } from './api';

export interface ActionKeys {
  /** The current key of `scope` (e.g. "sale", `receive:${id}`), created on first use. */
  for(scope: string): string;
  /** The action in `scope` succeeded: the next one gets a new key. */
  rotate(scope: string): void;
}

export function useActionKeys(): ActionKeys {
  const keys = useRef(new Map<string, string>());
  return useMemo(
    () => ({
      for(scope) {
        let k = keys.current.get(scope);
        if (!k) {
          k = newActionKey();
          keys.current.set(scope, k);
        }
        return k;
      },
      rotate(scope) {
        keys.current.delete(scope);
      },
    }),
    [],
  );
}
