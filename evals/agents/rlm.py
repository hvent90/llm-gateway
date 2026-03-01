"""
Harbor agent adapter for the RLM (Recursive Language Model) harness.

Implements BaseInstalledAgent so Harbor can install and run the RLM harness
inside Docker containers for Terminal-Bench evaluation.
"""

import os
import shlex
import shutil
import tempfile
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.models.agent.context import AgentContext


RESULT_PATH = "/tmp/rlm-result.txt"


class RlmAgent(BaseInstalledAgent):
    """Harbor adapter for the llm-gateway RLM harness."""

    @staticmethod
    def name() -> str:
        return "rlm"

    def version(self) -> str:
        return "0.1.0"

    @property
    def _install_agent_template_path(self) -> Path:
        """Jinja template that installs Bun + RLM harness in the container."""
        return Path(__file__).parent / ".." / "templates" / "install-rlm.sh.j2"

    async def setup(self, environment) -> None:
        """
        Upload the llm-gateway source needed by the RLM harness into the
        container before running the install script.
        """
        repo_root = Path(__file__).resolve().parents[2]
        staging_dir = Path(tempfile.mkdtemp(prefix="rlm-agent-src-"))

        def copy_path(rel_path: str) -> None:
            src = repo_root / rel_path
            dst = staging_dir / rel_path
            if not src.exists():
                return
            if src.is_file():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                return
            ignore = shutil.ignore_patterns(
                ".git",
                "node_modules",
                "dist",
                "build",
                ".DS_Store",
                "jobs",
                "results",
                "logs",
                "runs",
                ".idea",
                ".claude",
                ".agent",
                ".agents",
                ".cursor",
                ".gemini",
                ".windsurf",
                ".opencode",
            )
            shutil.copytree(src, dst, dirs_exist_ok=True, ignore=ignore)

        try:
            # Keep upload lean but sufficient for run-rlm.ts + harness imports.
            for rel_path in ("package.json", "bun.lock", "tsconfig.json", "evals", "packages"):
                copy_path(rel_path)

            await environment.exec("mkdir -p /opt/llm-gateway")
            await environment.upload_dir(staging_dir, "/opt/llm-gateway")
            await super().setup(environment)
        finally:
            shutil.rmtree(staging_dir, ignore_errors=True)

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

        return [
            ExecInput(
                command=(
                    f"cd /opt/llm-gateway && "
                    f"bun run evals/agents/run-rlm.ts {escaped_instruction} "
                    f"--model {shlex.quote(model)} "
                    f"2>&1 | tee /logs/agent/rlm.txt"
                ),
                env=env,
            )
        ]

    def populate_context_post_run(self, context: AgentContext) -> None:
        """
        Read the RLM harness result from /tmp/rlm-result.txt and populate
        the agent context.
        """
        result_path = Path(RESULT_PATH)

        if not result_path.exists():
            print(f"RLM result file {RESULT_PATH} does not exist")
            return

        try:
            result_text = result_path.read_text().strip()
        except Exception as e:
            print(f"Failed to read RLM result: {e}")
            return

        if not result_text:
            print("RLM result file is empty (harness may have hit max_iterations without FINAL())")
            return

        # Populate context with the result
        context.submission = result_text
