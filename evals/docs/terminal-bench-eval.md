# Terminal-Bench Evaluation Infrastructure

## Overview

Integrate [Terminal-Bench 2.0](https://www.tbench.ai/) into the llm-gateway monorepo to benchmark agent harnesses (starting with RLM, extensible to future harnesses) against real-world terminal tasks. Uses [Harbor](https://github.com/laude-institute/harbor) as the evaluation framework and an interactive TUI for orchestration.

## Background

Terminal-Bench is a benchmark by the Laude Institute that evaluates AI agents on ~100 real-world terminal tasks — compiling code, training models, configuring servers, debugging systems. Each task runs in a sandboxed Docker container and is verified programmatically with test scripts.

Harbor is the official framework for running Terminal-Bench 2.0. It handles container orchestration, parallel execution, cloud providers (Daytona, Modal, E2B), and result collection. Agents plug in via a Python adapter pattern implementing `BaseInstalledAgent`.

## Architecture

```
bun run evals
    │
    ▼
evals/cli/ (OpenTUI + Solid)
    │
    │  user selects harness, model, dataset, concurrency
    │
    ▼
harbor run --agent-import-path agents:RlmAgent -d terminal-bench@2.0 ...
    │
    │  Harbor spins up Docker containers per task
    │
    ▼
Container: Bun + packages/ai/rlm installed via Jinja template
    │
    │  RLM harness receives task instruction, uses exec() + REPL to solve
    │
    ▼
Task test script verifies result → pass/fail
```

## Folder Structure

```
llm-gateway/
  package.json                    # "evals": "bun evals/cli/index.tsx"

  evals/
    cli/                          # TUI app (OpenTUI + @opentui/solid)
      index.tsx                   # entry point
      prompts.tsx                 # interactive selection screens
      runner.ts                   # shells out to harbor
      compare.tsx                 # results diff view across harnesses

    agents/                       # Harbor agent adapters (Python)
      rlm.py                     # BaseInstalledAgent for RLM harness
      __init__.py

    templates/                    # Jinja install scripts for Docker containers
      install-base.sh.j2         # shared: install Bun, copy packages/ai/
      install-rlm.sh.j2          # RLM-specific setup

    pyproject.toml                # Python project (harbor dependency)
    harbor.toml                   # Harbor configuration
    results/                      # gitignored — raw trial output
```

## Key Components

### TUI (`evals/cli/`)

Built with [@opentui/solid](https://github.com/anomalyco/opentui). Single entry point via `bun run evals`. Prompts the user through:

- **Harness** — rlm, agent, future harnesses
- **Dataset** — terminal-bench@2.0, others
- **Model** — claude-sonnet-4-6, claude-haiku-4-5, etc.
- **Concurrency** — number of parallel trials
- **Compare** — view and diff results across harness runs

The TUI shells out to `harbor run` with the appropriate flags. No wrapper scripts — the TUI _is_ the interface.

### Harbor Adapters (`evals/agents/`)

Each harness gets a Python adapter implementing Harbor's `BaseInstalledAgent`:

```python
from harbor.agents.installed.base import BaseInstalledAgent
from pathlib import Path

class RlmAgent(BaseInstalledAgent):
    @property
    def _install_agent_template_path(self) -> Path:
        """Jinja template that installs Bun + RLM harness in container."""
        ...

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        """Invoke the RLM harness with the task instruction."""
        ...

    def populate_context_post_run(self, context) -> None:
        """Parse RLM output (FINAL() result, iterations, token usage)."""
        ...
```

Adding a new harness to benchmark = adding a new `.py` file here.

### Container Templates (`evals/templates/`)

Jinja templates that Harbor uses to set up each Docker container:

- `install-base.sh.j2` — installs Bun, copies `packages/ai/` into the container. Shared across all harness adapters.
- `install-rlm.sh.j2` — RLM-specific setup (dependencies, configuration).

The RLM harness's `exec()` runs shell commands directly, which maps naturally to Terminal-Bench's terminal-based tasks inside the container.

### Results (`evals/results/`)

Gitignored. Harbor writes trial output here. The TUI's compare view reads from this directory to diff pass rates, token usage, and iteration counts across harnesses and models.

## Dependencies

| Component  | Runtime | Dependencies                      |
| ---------- | ------- | --------------------------------- |
| TUI        | Bun     | `@opentui/core`, `@opentui/solid` |
| Adapters   | Python  | `harbor` (pip/uv)                 |
| Containers | Docker  | Bun, `packages/ai/` (copied in)   |

## Usage

```bash
# Install Python deps
cd evals && uv sync

# Run the eval TUI
bun run evals

# Or run harbor directly from evals/
cd evals
harbor run -d terminal-bench@2.0 --agent-import-path agents:RlmAgent -m anthropic/claude-sonnet-4-6 -n 8
```
