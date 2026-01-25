/**
 * A deferred promise that can be resolved or rejected externally.
 *
 * This is useful for inter-coroutine communication where one coroutine
 * needs to wait for a signal from another.
 *
 * @example
 * ```ts
 * const d = deferred<string>();
 *
 * // In one coroutine
 * const result = await d.promise;
 *
 * // In another coroutine
 * d.resolve("done");
 * ```
 */
export interface Deferred<T> {
  /** The promise that will be resolved/rejected */
  promise: Promise<T>;
  /** Resolve the promise with a value */
  resolve: (value: T) => void;
  /** Reject the promise with an error */
  reject: (error: Error) => void;
}

/**
 * Create a deferred promise with external resolve/reject controls.
 *
 * @returns A Deferred object with promise, resolve, and reject
 */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
