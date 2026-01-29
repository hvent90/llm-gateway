/**
 * A push-based async iterable for bridging imperative producers
 * with async iteration consumers.
 *
 * The orchestrator uses this to feed subagent events into the
 * multiplexer: it registers the passthrough's `iterable` with the
 * multiplexer, then pushes events from the subagent's generator.
 *
 * @example
 * ```ts
 * const pt = createPassthrough<number>();
 *
 * // Consumer (iterates values as they arrive)
 * async function consume() {
 *     for await (const v of pt.iterable) {
 *         console.log(v);
 *     }
 * }
 *
 * // Producer (pushes values imperatively)
 * pt.push(1);
 * pt.push(2);
 * pt.end();
 * ```
 */
interface Passthrough<T> {
  /** Push a value into the iterable. */
  push(value: T): void;
  /** Signal that no more values will be pushed. */
  end(): void;
  /** The async iterable that yields pushed values. */
  iterable: AsyncIterable<T>;
}

/**
 * Create a passthrough — an async iterable backed by a push/end interface.
 *
 * Values pushed before the consumer calls `next()` are buffered.
 * When the buffer is empty, the consumer waits until the next `push()` or `end()`.
 */
export function createPassthrough<T>(): Passthrough<T> {
  const buffer: T[] = [];
  let resolve: ((value: IteratorResult<T>) => void) | null = null;
  let done = false;

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffer.length > 0) {
            return Promise.resolve({ done: false, value: buffer.shift()! });
          }
          if (done) {
            return Promise.resolve({
              done: true,
              value: undefined as unknown as T,
            });
          }
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };

  return {
    push(value: T) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ done: false, value });
      } else {
        buffer.push(value);
      }
    },
    end() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ done: true, value: undefined as unknown as T });
      }
    },
    iterable,
  };
}
