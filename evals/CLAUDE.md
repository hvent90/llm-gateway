# evals

Evaluation infrastructure for benchmarking llm-gateway harnesses against Terminal-Bench 2.0.

## Structure

- `cli/` — Interactive TUI (OpenTUI + Solid) for running evals
- `agents/` — Harbor agent adapters (Python), one per harness
- `templates/` — Jinja install scripts for Docker containers
- `docs/` — Design docs and architecture notes
- `results/` — Gitignored raw trial output from Harbor

## Running

```bash
# From repo root
bun run evals

# Or directly with Harbor
cd evals && uv sync && harbor run -d terminal-bench@2.0 --agent-import-path agents:RlmAgent -m anthropic/claude-sonnet-4-6
```

## Adding a new harness

1. Create `agents/<harness>.py` implementing Harbor's `BaseInstalledAgent`
2. Create `templates/install-<harness>.sh.j2` for container setup
3. Register the harness in the TUI's selection list
