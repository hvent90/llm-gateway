import { useState, useRef, useEffect, type FormEvent } from "react";

interface InputAreaProps {
  onSubmit: (content: string) => void;
  onCancel: () => void;
  disabled: boolean;
  isStreaming: boolean;
  models: string[];
  selectedModel: string;
  onModelChange: (model: string) => void;
}

export function InputArea({
  onSubmit,
  onCancel,
  disabled,
  isStreaming,
  models,
  selectedModel,
  onModelChange,
}: InputAreaProps) {
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
      className="flex flex-col gap-2 border-t border-neutral-800 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4 sm:pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex gap-2">
        <select
          value={selectedModel}
          onChange={(e) => onModelChange(e.target.value)}
          disabled={isStreaming}
          className="border border-neutral-700 bg-black px-2 py-1 text-sm text-neutral-400 focus:border-white focus:outline-none disabled:opacity-50"
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-2">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={disabled ? "waiting..." : "type a message..."}
          className="flex-1 resize-none border border-neutral-700 bg-black px-3 py-2 text-base text-white placeholder-neutral-600 focus:border-white focus:outline-none disabled:opacity-50"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={onCancel}
            className="border border-neutral-700 bg-black px-4 py-2 text-base font-medium text-white hover:bg-neutral-900 active:bg-neutral-800"
          >
            stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || !value.trim()}
            className="border border-neutral-700 bg-black px-4 py-2 text-base font-medium text-white hover:bg-neutral-900 active:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            send
          </button>
        )}
      </div>
    </form>
  );
}
