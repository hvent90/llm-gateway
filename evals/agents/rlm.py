"""
Harbor agent adapter for the RLM (Recursive Language Model) harness.

Implements BaseInstalledAgent so Harbor can install and run the RLM harness
inside Docker containers for Terminal-Bench evaluation.
"""

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.models.agent.context import AgentContext


class RlmAgent(BaseInstalledAgent):
    """Harbor adapter for the llm-gateway RLM harness."""

    @staticmethod
    def name() -> str:
        return "rlm"

    def version(self) -> str:
        return "0.1.0"

    @property
    def _install_agent_template_path(self) -> Path:
        """Jinja template that verifies pre-built image contents."""
        return Path(__file__).parent / ".." / "templates" / "install-rlm.sh.j2"

    async def setup(self, environment) -> None:
        await super().setup(environment)

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        """
        Create commands to run the RLM harness with the task instruction.

        Shells out to the run-rlm.ts Bun script which imports the harness,
        runs it with the instruction as context, and writes the FINAL() output
        to /tmp/rlm-result.txt.
        """
        escaped_instruction = shlex.quote(instruction)

        # Resolve model from instance or environment
        model = getattr(self, "model_name", None) or os.environ.get(
            "RLM_MODEL", "claude-sonnet-4-6"
        )

        # Build environment variables for the Bun process
        env: dict[str, str] = {}

        # Forward API keys and eval event relay port
        for key in (
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
            "ZEN_API_KEY",
            "EVAL_EVENT_PORT",
        ):
            if key in os.environ:
                env[key] = os.environ[key]

        setup_command = "true"

        return [
            ExecInput(command=setup_command, env=env),
            ExecInput(
                command=(
                    "set -o pipefail; "
                    'export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"; '
                    'export PATH="$BUN_INSTALL/bin:$PATH"; '
                    'BUN_BIN="$(command -v bun || true)"; '
                    'if [[ -z "$BUN_BIN" && -x "$HOME/.bun/bin/bun" ]]; then BUN_BIN="$HOME/.bun/bin/bun"; fi; '
                    'if [[ -z "$BUN_BIN" ]]; then '
                    'echo "bun binary not found (expected on PATH or at $HOME/.bun/bin/bun)" >&2; '
                    "exit 127; "
                    "fi; "
                    'TASK_CWD="$(pwd)"; '
                    "cd /opt/llm-gateway && "
                    f'"$BUN_BIN" run evals/agents/run-rlm.ts {escaped_instruction} '
                    f"--model {shlex.quote(model)} "
                    '--cwd "$TASK_CWD" '
                    "2>&1 | tee /logs/agent/rlm.txt; "
                    "cp /tmp/rlm-result.txt /logs/agent/rlm-result.txt 2>/dev/null || true; "
                    "cp /tmp/rlm-metrics.json /logs/agent/rlm-metrics.json 2>/dev/null || true"
                ),
                env=env,
            ),
        ]

    def populate_context_post_run(self, context: AgentContext) -> None:
        """
        Read the RLM harness result and metrics from the logs directory (synced
        from /logs/agent/ inside the container) and populate the agent context.
        """
        import json

        # --- token metrics ---
        metrics_path = self.logs_dir / "rlm-metrics.json"
        if metrics_path.exists():
            try:
                metrics = json.loads(metrics_path.read_text())
                context.n_input_tokens = metrics.get("inputTokens") or None
                context.n_output_tokens = metrics.get("outputTokens") or None
                cache_read = metrics.get("cacheReadTokens", 0)
                cache_creation = metrics.get("cacheCreationTokens", 0)
                total_cache = (cache_read or 0) + (cache_creation or 0)
                context.n_cache_tokens = total_cache or None
            except Exception as e:
                print(f"Failed to read RLM metrics: {e}")

        # --- submission text ---
        result_path = self.logs_dir / "rlm-result.txt"

        if not result_path.exists():
            print(f"RLM result file not found at {result_path}")
            return

        try:
            result_text = result_path.read_text().strip()
        except Exception as e:
            print(f"Failed to read RLM result: {e}")
            return

        if not result_text:
            print("RLM result file is empty (harness may have hit max_iterations without FINAL())")
            return

        context.metadata = {
            **(context.metadata or {}),
            "submission": result_text,
        }
