import { useState } from "react";
import { InputArea } from "./components/InputArea";

export default function App() {
  const [isStreaming, setIsStreaming] = useState(false);

  const handleSubmit = (content: string) => {
    console.log("Submit:", content);
    // TODO: integrate with chat service
  };

  return (
    <div className="flex h-screen flex-col bg-gray-900 text-gray-100">
      <header className="border-b border-gray-700 px-4 py-3">
        <h1 className="text-lg font-semibold">LLM Gateway</h1>
      </header>
      <main className="flex-1 overflow-auto p-4">
        <p className="text-gray-400">Start a conversation below.</p>
      </main>
      <InputArea onSubmit={handleSubmit} disabled={isStreaming} />
    </div>
  );
}
