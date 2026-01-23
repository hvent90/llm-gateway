import type { PermissionRequest } from "../types";

interface PermissionPromptProps {
  request: PermissionRequest;
  onAllow: () => void;
  onAllowAll: () => void;
  onDeny: () => void;
}

export function PermissionPrompt({ request, onAllow, onAllowAll, onDeny }: PermissionPromptProps) {
  const paramsStr = JSON.stringify(request.params, null, 2);

  return (
    <div className="my-4 rounded border border-yellow-600 bg-yellow-900/20 p-4">
      <div className="mb-2 font-medium text-yellow-400">
        ⚠️ Permission Required
      </div>
      <div className="mb-2 text-sm text-gray-300">
        Tool: <span className="font-mono text-yellow-300">{request.tool}</span>
      </div>
      <pre className="mb-4 overflow-x-auto rounded bg-gray-800 p-2 text-sm text-gray-400">
        {paramsStr}
      </pre>
      <div className="flex gap-2">
        <button
          onClick={onAllow}
          className="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-700"
        >
          Allow
        </button>
        <button
          onClick={onAllowAll}
          className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
        >
          Allow All
        </button>
        <button
          onClick={onDeny}
          className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
