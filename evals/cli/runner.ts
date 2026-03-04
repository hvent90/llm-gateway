import { spawn } from "bun";
import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from "fs";
import { resolve, join, relative } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { startEventServer } from "./event-server";

/** Load a .env file into process.env (KEY=VALUE lines, # comments). */
function loadDotenv(path: string) {
  if (!existsSync(path)) return;
  const text = require("fs").readFileSync(path, "utf8") as string;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Don't override existing env vars
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Load .env from repo root so API keys are available to Harbor subprocesses.
const repoRoot = resolve(import.meta.dir, "../..");
loadDotenv(resolve(repoRoot, ".env"));

export interface EvalConfig {
  harness: string;
  dataset: string;
  taskNames: string[];
  model: string;
  concurrency: number;
}

const SOURCE_PATHS = ["package.json", "bun.lock", "tsconfig.json", "evals", "packages"];
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".DS_Store", "jobs", "results",
  "logs", "runs", ".idea", ".claude", ".agent", ".agents", ".cursor",
  ".gemini", ".windsurf", ".opencode", ".venv",
]);

function collectFiles(base: string, paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    const full = resolve(base, p);
    if (!existsSync(full)) continue;
    const stat = require("fs").statSync(full);
    if (stat.isFile()) {
      files.push(full);
    } else if (stat.isDirectory()) {
      walkDir(full, files);
    }
  }
  return files;
}

function walkDir(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

function computeSourceHash(): string {
  const files = collectFiles(repoRoot, SOURCE_PATHS);
  const entries: string[] = [];
  for (const file of files) {
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    entries.push(`${relative(repoRoot, file)}:${hash}`);
  }
  entries.sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function resolveTaskDir(taskName: string): string | null {
  const cacheDir = `${process.env.HOME}/.cache/harbor/tasks`;
  if (!existsSync(cacheDir)) return null;
  for (const hashDir of readdirSync(cacheDir, { withFileTypes: true })) {
    if (!hashDir.isDirectory()) continue;
    const candidate = join(cacheDir, hashDir.name, taskName);
    if (existsSync(join(candidate, "task.toml"))) return candidate;
  }
  return null;
}

/** When no specific tasks are selected, enumerate all cached task names. */
function listAllCachedTasks(): string[] {
  const cacheDir = `${process.env.HOME}/.cache/harbor/tasks`;
  if (!existsSync(cacheDir)) return [];
  const names: string[] = [];
  for (const hashDir of readdirSync(cacheDir, { withFileTypes: true })) {
    if (!hashDir.isDirectory()) continue;
    for (const child of readdirSync(join(cacheDir, hashDir.name), { withFileTypes: true })) {
      if (child.isDirectory() && existsSync(join(cacheDir, hashDir.name, child.name, "task.toml"))) {
        names.push(child.name);
      }
    }
  }
  return names;
}

function stageSource(): string {
  const staging = mkdtempSync(join(tmpdir(), "rlm-prebuilt-"));
  const dest = join(staging, "llm-gateway");
  for (const p of SOURCE_PATHS) {
    const src = resolve(repoRoot, p);
    if (!existsSync(src)) continue;
    const stat = require("fs").statSync(src);
    const target = join(dest, p);
    if (stat.isFile()) {
      cpSync(src, target);
    } else {
      cpSync(src, target, {
        recursive: true,
        filter: (source) => {
          const name = source.split("/").pop() ?? "";
          return !EXCLUDE_DIRS.has(name);
        },
      });
    }
  }
  return staging;
}

function writeDockerfile(stagingDir: string, baseImage: string): void {
  const dockerfile = `FROM ${baseImage}

RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates 2>/dev/null \\
    && rm -rf /var/lib/apt/lists/* \\
    || (apk add --no-cache curl unzip ca-certificates 2>/dev/null) \\
    || (dnf install -y curl unzip ca-certificates 2>/dev/null) \\
    || true

RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"
ENV PATH="/root/.bun/bin:$PATH"

COPY llm-gateway/ /opt/llm-gateway/
WORKDIR /opt/llm-gateway
RUN bun install --frozen-lockfile

# Enable core dumps for crash debugging
RUN mkdir -p /tmp/cores && chmod 777 /tmp/cores
RUN echo '/tmp/cores/core.%e.%p.%t' > /proc/sys/kernel/core_pattern 2>/dev/null || true
`;
  writeFileSync(join(stagingDir, "Dockerfile"), dockerfile);
}

function checkDocker(): string | null {
  const { existsSync } = require("fs") as typeof import("fs");
  const socketPaths = ["/var/run/docker.sock", `${process.env.HOME}/.docker/run/docker.sock`];
  if (socketPaths.some(existsSync)) return null;
  return "Docker socket not found — run `podman machine start` or start Docker Desktop before running evals.";
}

/** Build per-task Docker images that bake in Bun + llm-gateway source +
 *  node_modules on top of the task's base image.  Patches each task's
 *  task.toml to point to the derived image so Harbor uses it directly —
 *  zero runtime setup.  Built on the host before Harbor starts to avoid
 *  Harbor's agent setup timeout. */
async function ensurePrebuiltImages(
  taskNames: string[],
  onOutput: (line: string) => void,
): Promise<void> {
  const effectiveTaskNames = taskNames.length > 0 ? taskNames : listAllCachedTasks();
  if (effectiveTaskNames.length === 0) {
    onOutput(`[eval] No tasks found in cache — skipping image builds`);
    return;
  }

  const sourceHash = computeSourceHash();
  onOutput(`[eval] Source hash: ${sourceHash.slice(0, 12)} — ${effectiveTaskNames.length} task(s)`);

  let stagingDir: string | null = null;

  for (const taskName of effectiveTaskNames) {
    const taskDir = resolveTaskDir(taskName);
    if (!taskDir) {
      onOutput(`[eval] WARN: task dir not found for ${taskName} — skipping image build`);
      continue;
    }

    const tomlPath = join(taskDir, "task.toml");
    const tomlText = readFileSync(tomlPath, "utf8");
    const toml = Bun.TOML.parse(tomlText) as Record<string, any>;
    const currentImage: string | undefined = toml?.environment?.docker_image;
    if (!currentImage) {
      onOutput(`[eval] WARN: no docker_image in ${taskName}/task.toml — skipping`);
      continue;
    }

    // Recover the original base image: either from our comment marker in
    // task.toml (if we patched it before) or from the current value.
    const origMarker = tomlText.match(/^# rlm\.base-image = "([^"]+)"/m);
    const baseImage = origMarker ? origMarker[1] : currentImage;

    // If the current image is already our derived tag, the base is whatever
    // the marker says.  If there's no marker and the image starts with rlm/,
    // we can't determine the original base — skip.
    if (!origMarker && currentImage.startsWith("rlm/")) {
      onOutput(`[eval] WARN: ${taskName}/task.toml already patched but missing base marker — skipping`);
      continue;
    }

    const imageTag = `rlm/${taskName}:latest`;

    // Check if existing image has matching source hash
    const inspect = spawn({
      cmd: [
        "docker", "image", "inspect", imageTag,
        "--format", '{{index .Config.Labels "rlm.source-hash"}}',
      ],
      stdout: "pipe",
      stderr: "ignore",
    });
    const inspectOut = await new Response(inspect.stdout).text();
    if ((await inspect.exited) === 0 && inspectOut.trim() === sourceHash) {
      onOutput(`[eval] Image ${imageTag} up to date`);
    } else {
      // Stage source once (shared across all task builds)
      if (!stagingDir) {
        onOutput(`[eval] Staging source tree...`);
        stagingDir = stageSource();
      }

      writeDockerfile(stagingDir!, baseImage);
      onOutput(`[eval] Building ${imageTag} (FROM ${baseImage})...`);

      const build = spawn({
        cmd: [
          "docker", "buildx", "build",
          "--platform", "linux/amd64",
          "--label", `rlm.source-hash=${sourceHash}`,
          "--label", `rlm.base-image=${baseImage}`,
          "-t", imageTag,
          "--load",
          stagingDir,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });

      async function drain(stream: ReadableStream<Uint8Array>) {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split(/\n/)) {
            if (line.trim()) onOutput(`[build:${taskName}] ${line}`);
          }
        }
      }

      await Promise.all([drain(build.stdout), drain(build.stderr)]);
      const code = await build.exited;
      if (code !== 0) {
        onOutput(`[eval] ERROR: image build failed for ${taskName} (exit ${code})`);
        continue;
      }
      onOutput(`[eval] Built ${imageTag}`);
    }

    // Patch task.toml to use our derived image, preserving the original
    // base image in a comment so we can recover it on future runs.
    let patched = tomlText;
    // Add base marker comment if not present
    if (!origMarker) {
      patched = patched.replace(
        /^(\s*docker_image\s*=\s*"[^"]*")/m,
        `# rlm.base-image = "${baseImage}"\n$1`,
      );
    }
    // Replace docker_image value
    patched = patched.replace(
      /^(\s*docker_image\s*=\s*)"[^"]*"/m,
      `$1"${imageTag}"`,
    );
    if (patched !== tomlText) {
      writeFileSync(tomlPath, patched);
      onOutput(`[eval] Patched ${taskName}/task.toml → ${imageTag}`);
    }
  }

  // Clean up staging dir
  if (stagingDir) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export async function runEval(
  config: EvalConfig,
  onOutput: (line: string) => void,
  onEvent?: (event: unknown) => void,
): Promise<number> {
  const agentMap: Record<string, string> = {
    rlm: "evals.agents.rlm:RlmAgent",
  };

  const dockerError = checkDocker();
  if (dockerError) {
    onOutput(`[eval] ERROR: ${dockerError}`);
    return 1;
  }

  // Build per-task Docker images before Harbor starts so builds aren't
  // subject to Harbor's agent setup timeout.
  await ensurePrebuiltImages(config.taskNames, onOutput);

  // Start event relay server so Docker containers can POST events back
  let eventServer: ReturnType<typeof startEventServer> | undefined;
  if (onEvent) {
    try {
      eventServer = startEventServer(onEvent);
      onOutput(`[eval] Event relay listening on port ${eventServer.port}`);
    } catch (error) {
      // Eval runs without live REPL events if local HTTP bind fails.
      onOutput(`[eval] Event relay disabled: ${String(error)}`);
    }
  }

  // Prefer venv-local harbor so the runner works without activating the venv.
  const { existsSync } = require("fs") as typeof import("fs");
  const { resolve } = require("path") as typeof import("path");
  const venvHarbor = resolve(import.meta.dir, "../.venv/bin/harbor");
  const harborBin = existsSync(venvHarbor) ? venvHarbor : "harbor";

  const cmd = [
    harborBin,
    "run",
    "-d",
    config.dataset,
    "--jobs-dir",
    "evals/jobs",
    "--agent-import-path",
    agentMap[config.harness] ?? config.harness,
    "-m",
    config.model,
    "-n",
    String(config.concurrency),
  ];

  for (const task of config.taskNames) {
    cmd.push("-t", task);
  }

  const runCwd = import.meta.dir + "/../..";
  onOutput(`[eval] Working directory: ${runCwd}`);
  onOutput(`[eval] Starting: ${cmd.join(" ")}`);

  const proc = spawn({
    cmd,
    cwd: runCwd, // repo root
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      ...(eventServer ? { EVAL_EVENT_PORT: String(eventServer.port) } : {}),
    },
  });

  // --- Cleanup on interrupt ---
  // When the user Ctrl+C's out of the TUI, the Harbor process (and its
  // Docker containers) would otherwise keep running in the background.
  // Kill Harbor, stop any Docker containers it spawned, and tear down
  // the event server.
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try { proc.kill("SIGTERM"); } catch {}
    try { eventServer?.server.stop(); } catch {}
    // Stop Docker containers spawned from rlm/* images (Harbor uses
    // docker-compose under the hood but doesn't clean up on SIGTERM).
    try {
      const ps = spawnSync("docker", [
        "ps", "--format", "{{.ID}} {{.Image}}",
      ], { encoding: "utf8", timeout: 5_000 });
      const ids = (ps.stdout ?? "").split("\n")
        .filter((l) => / rlm\//.test(l))
        .map((l) => l.split(" ")[0]!)
        .filter(Boolean);
      if (ids.length > 0) {
        spawnSync("docker", ["stop", ...ids], { timeout: 30_000 });
      }
    } catch {}
  }

  const onSignal = () => { cleanup(); process.exit(1); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", cleanup);

  async function readStream(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\n|\r/);
      const hasTrailingNewline = /\r\n$|\n$|\r$/.test(buffer);
      buffer = hasTrailingNewline ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        onOutput(line);
      }
      // Harbor can write long chunks without newline; flush them immediately.
      if (buffer) {
        onOutput(buffer);
        buffer = "";
      }
    }

    buffer += decoder.decode();
    if (buffer) onOutput(buffer);
  }

  await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);

  const exitCode = await proc.exited;

  // Normal exit — clean up and remove signal handlers so they don't
  // leak if runEval is called multiple times in the same process.
  cleanup();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  process.off("exit", cleanup);

  return exitCode;
}
