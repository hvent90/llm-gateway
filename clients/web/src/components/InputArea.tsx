import { useState, useRef, useEffect, type FormEvent } from "react";

interface InputAreaProps {
  onSubmit: (content: string) => void;
  onCancel: () => void;
  disabled: boolean;
  isStreaming: boolean;
}

export function InputArea({ onSubmit, onCancel, disabled, isStreaming }: InputAreaProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus();
    }
  }, [disabled]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const trimmed = value.trim();
    if (trimmed && !disabled) {
      onSubmit(trimmed);
      setValue("");
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const trimmed = value.trim();
      if (trimmed && !disabled) {
        onSubmit(trimmed);
        setValue("");
        if (inputRef.current) {
          inputRef.current.style.height = "auto";
        }
      }
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex gap-2 border-t border-gray-700 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4 sm:pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          // Auto-resize
          e.target.style.height = "auto";
          e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
        }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={1}
        placeholder={disabled ? "Waiting..." : "Type a message..."}
        className="flex-1 resize-none rounded border border-gray-600 bg-gray-800 px-3 py-2 text-base text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none disabled:opacity-50"
      />
      {isStreaming ? (
        <button
          type="button"
          onClick={onCancel}
          className="rounded bg-red-600 px-4 py-2 text-base font-medium text-white hover:bg-red-700 active:bg-red-800"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className="rounded bg-blue-600 px-4 py-2 text-base font-medium text-white hover:bg-blue-700 active:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-600"
        >
          Send
        </button>
      )}
    </form>
  );
}
