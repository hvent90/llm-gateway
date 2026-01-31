import picomatch from "picomatch";
import type { Permissions, ToolPermission } from "./types";

interface ToolCallLike {
  name: string;
  arguments?: Record<string, unknown>;
}

export function derivePermission(tool: string, params?: Record<string, unknown>): ToolPermission {
  if (!params || Object.keys(params).length === 0) {
    return { tool };
  }

  const derived: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const str = String(value);
    const spaceIndex = str.indexOf(" ");
    derived[key] = spaceIndex === -1 ? str : str.slice(0, spaceIndex) + " **";
  }

  return { tool, params: derived };
}

export function matchesPermission(toolCall: ToolCallLike, permission: ToolPermission): boolean {
  if (toolCall.name !== permission.tool) {
    return false;
  }

  if (!permission.params) {
    return true;
  }

  for (const [paramName, pattern] of Object.entries(permission.params)) {
    const value = toolCall.arguments?.[paramName];
    if (value === undefined) {
      return false;
    }
    if (!picomatch.isMatch(String(value), pattern, { bash: true })) {
      return false;
    }
  }

  return true;
}

export function matchesPermissions(
  toolCall: ToolCallLike,
  permissions?: Pick<Permissions, "allowlist" | "allowOnce">,
): boolean {
  const allAllowed = [...(permissions?.allowlist ?? []), ...(permissions?.allowOnce ?? [])];
  return allAllowed.some((p) => matchesPermission(toolCall, p));
}
