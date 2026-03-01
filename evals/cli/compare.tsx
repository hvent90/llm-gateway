import { createResource, For, Show, type Accessor } from "solid-js";
import { type JobSummary, loadJobSummaries } from "./load-jobs";

export function CompareView(props: { trigger: Accessor<number> }) {
  const [jobs] = createResource(props.trigger, loadJobSummaries);

  return (
    <box flexDirection="column" padding={1}>
      <text fg="#0ff">
        <strong>Eval Results Comparison</strong>
      </text>
      <box height={1} />
      <Show when={!jobs.loading} fallback={<text fg="#888">Loading results...</text>}>
        <Show
          when={(jobs() ?? []).length > 0}
          fallback={<text fg="#888">No jobs found in evals/jobs/</text>}
        >
          <box flexDirection="column">
            <box flexDirection="row">
              <box width={24}>
                <text fg="#ff0">
                  <strong>Job</strong>
                </text>
              </box>
              <box width={24}>
                <text fg="#ff0">
                  <strong>Model</strong>
                </text>
              </box>
              <box width={24}>
                <text fg="#ff0">
                  <strong>Dataset</strong>
                </text>
              </box>
              <box width={12}>
                <text fg="#ff0">
                  <strong>Pass</strong>
                </text>
              </box>
              <box width={10}>
                <text fg="#ff0">
                  <strong>Errors</strong>
                </text>
              </box>
              <box width={10}>
                <text fg="#ff0">
                  <strong>Score</strong>
                </text>
              </box>
              <box width={12}>
                <text fg="#ff0">
                  <strong>Status</strong>
                </text>
              </box>
            </box>
            <text fg="#444">{"─".repeat(116)}</text>
            <For each={jobs() ?? []}>
              {(job) => {
                const pass =
                  job.passed != null && job.total != null
                    ? `${job.passed}/${job.total}`
                    : job.total != null
                      ? `—/${job.total}`
                      : "—";
                const errors = job.errors != null ? String(job.errors) : "—";
                const score = job.meanScore != null ? job.meanScore.toFixed(2) : "—";
                const status = job.finished ? "done" : "running";
                const statusColor = job.finished ? "#44ff44" : "#ffaa00";

                return (
                  <box flexDirection="row">
                    <box width={24}>
                      <text>{job.jobName}</text>
                    </box>
                    <box width={24}>
                      <text>{job.model}</text>
                    </box>
                    <box width={24}>
                      <text>{job.dataset}</text>
                    </box>
                    <box width={12}>
                      <text>{pass}</text>
                    </box>
                    <box width={10}>
                      <text>{errors}</text>
                    </box>
                    <box width={10}>
                      <text>{score}</text>
                    </box>
                    <box width={12}>
                      <text fg={statusColor}>{status}</text>
                    </box>
                  </box>
                );
              }}
            </For>
          </box>
        </Show>
      </Show>
    </box>
  );
}
