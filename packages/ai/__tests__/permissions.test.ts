import { describe, it, expect } from "bun:test";
import { derivePermission, matchesPermission, matchesPermissions } from "../permissions";

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

  describe("derivePermission", () => {
    it("splits multi-word string param into firstWord + glob", () => {
      const result = derivePermission("bash", { command: "cat /tmp/foo.txt" });
      expect(result).toEqual({ tool: "bash", params: { command: "cat **" } });
    });

    it("splits two-word string param into firstWord + glob", () => {
      const result = derivePermission("bash", { command: "ls -la" });
      expect(result).toEqual({ tool: "bash", params: { command: "ls **" } });
    });

    it("keeps single-word string param as exact value", () => {
      const result = derivePermission("get_weather", { city: "London" });
      expect(result).toEqual({ tool: "get_weather", params: { city: "London" } });
    });

    it("omits params when params object is empty", () => {
      const result = derivePermission("greet", {});
      expect(result).toEqual({ tool: "greet" });
    });

    it("coerces non-string param values with String()", () => {
      const result = derivePermission("set_volume", { level: 42 });
      expect(result).toEqual({ tool: "set_volume", params: { level: "42" } });
    });

    it("handles multiple params independently", () => {
      const result = derivePermission("file_write", {
        path: "/tmp/foo.txt",
        content: "hello world",
      });
      expect(result).toEqual({
        tool: "file_write",
        params: { path: "/tmp/foo.txt", content: "hello **" },
      });
    });

    it("derived permission matches the original call via matchesPermission", () => {
      const toolCall = { name: "bash", arguments: { command: "cat /tmp/foo.txt" } };
      const permission = derivePermission("bash", { command: "cat /tmp/foo.txt" });
      expect(matchesPermission(toolCall, permission)).toBe(true);
    });

    it("derived permission matches similar calls with same first word", () => {
      const permission = derivePermission("bash", { command: "ls -la" });
      expect(
        matchesPermission({ name: "bash", arguments: { command: "ls /home" } }, permission),
      ).toBe(true);
    });

    it("derived permission rejects calls with different first word", () => {
      const permission = derivePermission("bash", { command: "ls -la" });
      expect(
        matchesPermission({ name: "bash", arguments: { command: "rm -rf /" } }, permission),
      ).toBe(false);
    });

    it("derived multi-word permission does NOT match bare first-word call", () => {
      const permission = derivePermission("bash", { command: "cat /tmp/foo.txt" });
      expect(
        matchesPermission({ name: "bash", arguments: { command: "cat" } }, permission),
      ).toBe(false);
    });

    it("omits params when params is undefined", () => {
      const result = derivePermission("greet", undefined);
      expect(result).toEqual({ tool: "greet" });
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
});
