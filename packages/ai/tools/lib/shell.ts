import { spawn } from "bun";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function readStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    // Stream cancelled or errored — return whatever we collected
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function execShell(options: {
  command: string;
  timeout?: number;
}): Promise<ShellResult> {
  const timeout = options.timeout ?? 5;

  const proc = spawn({
    cmd: ["sh", "-c", options.command],
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });

  const stdoutReader = proc.stdout.getReader();
  const stderrReader = proc.stderr.getReader();

  const kill = () => {
    // Kill process group AND individual process — belt and suspenders.
    // The group kill gets pipeline children; the direct kill is a fallback.
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
    try {
      proc.kill(9);
    } catch {}
    // Cancel stream readers so the completion promise can resolve
    // instead of dangling with open pipe references.
    stdoutReader.cancel().catch(() => {});
    stderrReader.cancel().catch(() => {});
  };

  const completionPromise = (async () => {
    const [stdout, stderr] = await Promise.all([
      readStream(stdoutReader),
      readStream(stderrReader),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode, timedOut: false as const };
  })();

  // Suppress unhandled rejection if timeout wins the race
  // and the completion promise later rejects from stream cleanup.
  completionPromise.catch(() => {});

  let timer: Timer;
  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      kill();
      resolve({ timedOut: true });
    }, timeout * 1000);
  });

  const raceResult = await Promise.race([completionPromise, timeoutPromise]);
  clearTimeout(timer!);

  if (raceResult.timedOut) {
    return { exitCode: -1, stdout: "", stderr: "" };
  }

  const { stdout, stderr, exitCode } = raceResult;
  return { stdout, stderr, exitCode };
}
