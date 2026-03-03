# evals

Evaluation infrastructure for benchmarking llm-gateway harnesses against Terminal-Bench 2.0.

## Structure

- `cli/` — Interactive TUI (OpenTUI + Solid) for running evals
- `agents/` — Harbor agent adapters (Python), one per harness
- `templates/` — Jinja install scripts for Docker containers
- `docs/` — Design docs and architecture notes
- `results/` — Gitignored raw trial output from Harbor

## Prerequisites

- **Docker** — Terminal-Bench runs each trial inside a Docker container. Install Docker Desktop and ensure the daemon is running before launching evals.
- **uv** — Python package manager used to install Harbor. Run `cd evals && uv sync` once before first use.

## Running

```bash
# From repo root
bun run evals

# Or directly with Harbor
cd evals && uv sync && .venv/bin/harbor run -d terminal-bench@2.0 --agent-import-path agents:RlmAgent -m anthropic/claude-sonnet-4-6
```

## Per-Task Pre-Built Docker Images

Before Harbor starts, `runner.ts` builds per-task Docker images that derive from the task's base image (e.g. `alexgshaw/fix-git-history:20251031`) and bake in Bun + llm-gateway source + `node_modules`. Each task's `task.toml` is patched to point to the derived `rlm/<task-name>:latest` image. Images are tagged with a source hash label and only rebuilt when source changes.

The install script (`install-rlm.sh.j2`) only verifies the pre-built contents are present — no runtime downloads or installs needed.

## Adding a new harness

1. Create `agents/<harness>.py` implementing Harbor's `BaseInstalledAgent`
2. Create `templates/install-<harness>.sh.j2` for container setup
3. Register the harness in the TUI's selection list
