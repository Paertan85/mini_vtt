// Event handlers with a fixed identity, for memoized children.

import { useRef, useState } from 'react';

type Handler = (...args: never[]) => unknown;

/**
 * Handlers whose identity never changes but which always call the latest
 * version passed in. A memoized child given these re-renders only when its
 * data changes, not because its parent recreated its handlers on a render
 * (60 times a second while something is dragged). The keys must stay the same
 * from one render to the next.
 */
export function useHandlers<T extends Record<string, Handler>>(handlers: T): T {
  const latest = useRef(handlers);
  latest.current = handlers;
  const [stable] = useState(
    () =>
      Object.fromEntries(
        Object.keys(handlers).map((key) => [
          key,
          (...args: unknown[]) => (latest.current[key] as (...args: unknown[]) => unknown)(...args),
        ]),
      ) as unknown as T,
  );
  return stable;
}
