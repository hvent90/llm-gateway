import { describe, it, expect } from "bun:test";
import { matchesPermission, matchesPermissions } from "../permissions";
import { bashTool } from "../tools/bash";

describe("permissions", () => {
  describe("matchesPermission", () => {
    it("matches tool name only", () => {
      const result = matchesPermission(
        { name: "get_weather", arguments: { city: "London" } },
        { tool: "get_weather" },
      );
      expect(result).toBe(true);
    });

    it("rejects different tool name", () => {
      const result = matchesPermission(
        { name: "get_weather", arguments: { city: "London" } },
        { tool: "calculator" },
      );
      expect(result).toBe(false);
    });

    it("matches with glob pattern", () => {
      const result = matchesPermission(
        { name: "bash", arguments: { command: "ls -la" } },
        { tool: "bash", params: { command: "ls *" } },
      );
      expect(result).toBe(true);
    });

    it("rejects non-matching glob pattern", () => {
      const result = matchesPermission(
        { name: "bash", arguments: { command: "rm -rf /" } },
        { tool: "bash", params: { command: "ls *" } },
      );
      expect(result).toBe(false);
    });

    it("allows unspecified params when some params have patterns", () => {
      const result = matchesPermission(
        { name: "file_write", arguments: { path: "/tmp/foo.txt", content: "hello" } },
        { tool: "file_write", params: { path: "/tmp/*" } },
      );
      expect(result).toBe(true);
    });

    it("handles missing arguments gracefully", () => {
      const result = matchesPermission(
        { name: "bash", arguments: undefined },
        { tool: "bash", params: { command: "ls *" } },
      );
      expect(result).toBe(false);
    });
  });

  describe("matchesPermissions", () => {
    it("returns true if any allowlist entry matches", () => {
      const result = matchesPermissions(
        { name: "get_weather", arguments: { city: "London" } },
        { allowlist: [{ tool: "calculator" }, { tool: "get_weather" }] },
      );
      expect(result).toBe(true);
    });

    it("returns true if any allowOnce entry matches", () => {
      const result = matchesPermissions(
        { name: "bash", arguments: { command: "ls -la" } },
        { allowOnce: [{ tool: "bash", params: { command: "ls *" } }] },
      );
      expect(result).toBe(true);
    });

    it("returns false if no entries match", () => {
      const result = matchesPermissions(
        { name: "dangerous_tool", arguments: {} },
        { allowlist: [{ tool: "safe_tool" }], allowOnce: [] },
      );
      expect(result).toBe(false);
    });

    it("returns false for empty permissions", () => {
      const result = matchesPermissions({ name: "any_tool", arguments: {} }, {});
      expect(result).toBe(false);
    });

    it("returns false for undefined permissions", () => {
      const result = matchesPermissions({ name: "any_tool", arguments: {} }, undefined);
      expect(result).toBe(false);
    });
  });

  describe("bashTool.derivePermission", () => {
    it("derives first-word glob from command", () => {
      const result = bashTool.derivePermission!({ command: "cat /tmp/foo.txt" });
      expect(result).toEqual({ tool: "bash", params: { command: "cat **" } });
    });

    it("keeps single-word command exact", () => {
      const result = bashTool.derivePermission!({ command: "ls" });
      expect(result).toEqual({ tool: "bash", params: { command: "ls" } });
    });
  });
});
