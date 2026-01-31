import picomatch from "picomatch";
import type { Permissions, ToolPermission } from "./types";

interface ToolCallLike {
  name: string;
  arguments?: Record<string, unknown>;
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
