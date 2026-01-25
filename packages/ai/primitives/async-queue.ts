/**
 * An async queue for inter-coroutine signaling.
 *
 * Provides a FIFO queue where `pop()` returns a promise that resolves
 * when an item is available. This enables producer/consumer patterns
 * between async generators.
 *
 * @example
 * ```ts
 * const queue = new AsyncQueue<number>();
 *
 * // Consumer (waits for items)
 * async function consumer() {
 *     while (true) {
 *         const item = await queue.pop();
 *         console.log("Got:", item);
 *     }
 * }
 *
 * // Producer (pushes items)
 * queue.push(1);
 * queue.push(2);
 * ```
 */
export class AsyncQueue<T> {
  private queue: T[] = [];
  private waiting: Array<(value: T) => void> = [];

  /**
   * Push an item to the queue.
   *
   * If there are waiting consumers, the first one receives
   * the value immediately. Otherwise, the value is queued.
   */
  push(value: T): void {
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter(value);
    } else {
      this.queue.push(value);
    }
  }

  /**
   * Pop an item from the queue.
   *
   * Returns immediately if items are queued.
   * Otherwise, returns a promise that resolves when an item is pushed.
   */
  async pop(): Promise<T> {
    if (this.queue.length > 0) {
      return this.queue.shift() as T;
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /**
   * The number of items currently queued.
   *
   * Note: This does not include waiting consumers.
   */
  get length(): number {
    return this.queue.length;
  }
}
