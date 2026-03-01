import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { EvalConfig } from "./runner";

export interface JobSummary {
  jobName: string;
  harness: string;
  model: string;
  dataset: string;
  passed: number | null;
  total: number | null;
  totalExpected: number | null;
  errors: number | null;
  meanScore: number | null;
  finished: boolean;
  startedAt: string | null;
}

interface ResultJson {
  started_at?: string | null;
  finished_at?: string | null;
  n_total_trials?: number;
  stats?: {
    n_trials?: number;
    n_errors?: number;
    evals?: Record<
      string,
      {
        n_trials?: number;
        n_errors?: number;
        metrics?: Array<{ mean?: number }>;
        reward_stats?: Record<string, number>;
      }
    >;
  };
}

interface ConfigJson {
  orchestrator?: { n_concurrent_trials?: number };
  agents?: Array<{ import_path?: string; model_name?: string }>;
  datasets?: Array<{ name?: string; version?: string; task_names?: string[] | null }>;
}

const HARNESS_BY_IMPORT_PATH: Record<string, string> = {
  "agents:RlmAgent": "rlm",
};

function listJobDirectories(jobsDir: string): string[] {
  return readdirSync(jobsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
}

function parseEvalConfig(config: ConfigJson): EvalConfig | null {
  const agent = config.agents?.[0];
  const datasetConfig = config.datasets?.[0];

  if (!agent || !datasetConfig) return null;

  const importPath = agent.import_path?.trim();
  const model = agent.model_name?.trim();
  const datasetName = datasetConfig.name?.trim();
  const datasetVersion = datasetConfig.version?.trim();

  if (!importPath || !model || !datasetName) return null;

  const taskNames = Array.isArray(datasetConfig.task_names)
    ? datasetConfig.task_names.filter((name): name is string => typeof name === "string")
    : [];

  const rawConcurrency = config.orchestrator?.n_concurrent_trials;
  const concurrency =
    typeof rawConcurrency === "number" && Number.isInteger(rawConcurrency) && rawConcurrency > 0
      ? rawConcurrency
      : 4;

  return {
    harness: HARNESS_BY_IMPORT_PATH[importPath] ?? importPath,
    dataset: datasetVersion ? `${datasetName}@${datasetVersion}` : datasetName,
    taskNames,
    model,
    concurrency,
  };
}

export async function loadJobSummaries(): Promise<JobSummary[]> {
  const jobsDir = join(import.meta.dir, "../jobs");
  if (!existsSync(jobsDir)) return [];

  const dirs = listJobDirectories(jobsDir);

  const summaries: JobSummary[] = [];

  for (const dirName of dirs) {
    const configPath = join(jobsDir, dirName, "config.json");
    const resultPath = join(jobsDir, dirName, "result.json");
    if (!existsSync(configPath) || !existsSync(resultPath)) continue;

    try {
      const config: ConfigJson = JSON.parse(await Bun.file(configPath).text());
      const result: ResultJson = JSON.parse(await Bun.file(resultPath).text());

      const agent = config.agents?.[0];
      const ds = config.datasets?.[0];
      const evalEntry = result.stats?.evals ? Object.values(result.stats.evals)[0] : undefined;
      const rewardStats = evalEntry?.reward_stats ?? {};
      const passCount = rewardStats["1.0"] ?? rewardStats["1"] ?? null;

      summaries.push({
        jobName: dirName,
        harness: agent?.import_path ?? "unknown",
        model: agent?.model_name ?? "unknown",
        dataset: ds ? `${ds.name ?? "?"}@${ds.version ?? "?"}` : "unknown",
        passed: passCount,
        total: result.stats?.n_trials ?? null,
        totalExpected: result.n_total_trials ?? null,
        errors: result.stats?.n_errors ?? null,
        meanScore: evalEntry?.metrics?.[0]?.mean ?? null,
        finished: result.finished_at != null,
        startedAt: result.started_at ?? null,
      });
    } catch {
      // skip malformed jobs
    }
  }

  return summaries;
}

export async function loadMostRecentEvalConfig(): Promise<EvalConfig | null> {
  const jobsDir = join(import.meta.dir, "../jobs");
  if (!existsSync(jobsDir)) return null;

  const dirs = listJobDirectories(jobsDir);

  for (const dirName of dirs) {
    const configPath = join(jobsDir, dirName, "config.json");
    if (!existsSync(configPath)) continue;

    try {
      const config: ConfigJson = JSON.parse(await Bun.file(configPath).text());
      const parsed = parseEvalConfig(config);
      if (parsed) return parsed;
    } catch {
      // skip malformed jobs
    }
  }

  return null;
}
