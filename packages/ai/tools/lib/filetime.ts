import { stat } from "fs/promises";

export class FileTime {
  private times = new Map<string, number>();
  private locks = new Map<string, Promise<void>>();

  /** Record the current mtime for a file. */
  async read(filePath: string): Promise<void> {
    const s = await stat(filePath);
    this.times.set(filePath, s.mtimeMs);
  }

  /**
   * Assert the file has been read and has not been modified since.
   * Throws if never read or if mtime differs.
   */
  async assert(filePath: string): Promise<void> {
    const recorded = this.times.get(filePath);
    if (recorded === undefined) {
      throw new Error(`${filePath} must be read before patching`);
    }
    let current: number;
    try {
      const s = await stat(filePath);
      current = s.mtimeMs;
    } catch {
      throw new Error(`${filePath} was deleted after last read`);
    }
    if (current !== recorded) {
      throw new Error(
        `${filePath} has been modified externally since last read. Please re-read before patching.`,
      );
    }
  }

  /** Serialize operations on the same file path. */
  async withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(filePath) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    this.locks.set(filePath, next);
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }
}
