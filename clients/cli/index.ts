/**
 * LLM Gateway CLI Client
 *
 * Interactive terminal-based client for the LLM Gateway server.
 * Uses OpenTUI for rendering a rich terminal interface with:
 * - Header display
 * - Scrollable conversation history
 * - Text input for user prompts
 * - SSE streaming for real-time responses
 */

import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  type CliRenderer,
  StyledText,
  t,
  dim,
  italic,
} from "@opentui/core";

// Configuration from environment
const MODEL = process.env.LLM_MODEL ?? "nvidia/nemotron-nano-9b-v2:free";
const SERVER_URL = process.env.LLM_GATEWAY_URL ?? "http://localhost:4000";

// Message types (matching packages/ai/types.ts)
interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

// Server event types
type ServerEvent =
  | { type: "text"; runId: string; id: string; content: string }
  | { type: "reasoning"; runId: string; id: string; content: string }
  | { type: "tool_call"; runId: string; id: string; name: string; input: unknown }
  | { type: "tool_result"; runId: string; id: string; output: unknown }
  | { type: "error"; runId: string; message: string };

// Conversation state
interface ConversationState {
  messages: Message[];
  isStreaming: boolean;
  currentAssistantContent: string;
  isInReasoning: boolean;
}

/**
 * Main CLI client
 */
class CliClient {
  private renderer: CliRenderer | null = null;
  private conversationView: ScrollBoxRenderable | null = null;
  private conversationContent: TextRenderable | null = null;
  private inputField: InputRenderable | null = null;
  private statusText: TextRenderable | null = null;

  private state: ConversationState = {
    messages: [],
    isStreaming: false,
    currentAssistantContent: "",
    isInReasoning: false,
  };

  private contentSegments: Array<{ text: string; isReasoning: boolean }> = [
    { text: "Welcome! Type a message and press Enter to start chatting.\n", isReasoning: false },
  ];

  async start(): Promise<void> {
    this.renderer = await createCliRenderer({
      exitOnCtrlC: true,
      useAlternateScreen: true,
      useMouse: true,
    });

    this.setupLayout();
    this.renderer.start();

    // Focus the input field
    this.inputField?.focus();
  }

  /**
   * Setup the UI layout:
   * ┌─────────────────────────────────────┐
   * │ LLM Gateway CLI                     │
   * ├─────────────────────────────────────┤
   * │ [Conversation history - scrollable] │
   * ├─────────────────────────────────────┤
   * │ > [Input field]                     │
   * └─────────────────────────────────────┘
   */
  private setupLayout(): void {
    if (!this.renderer) return;

    // Root container
    const root = new BoxRenderable(this.renderer, {
      id: "root",
      flexDirection: "column",
      width: "100%",
      height: "100%",
    });

    // Header
    const header = new BoxRenderable(this.renderer, {
      id: "header-box",
      height: 3,
      border: true,
      borderStyle: "rounded",
      borderColor: "#3b82f6",
      padding: 0,
      paddingLeft: 1,
      paddingRight: 1,
    });

    const headerText = new TextRenderable(this.renderer, {
      id: "header-text",
      content: `LLM Gateway CLI  |  Model: ${MODEL}`,
      width: "100%",
    });
    header.add(headerText);

    // Conversation area (scrollable)
    const conversationBox = new BoxRenderable(this.renderer, {
      id: "conversation-box",
      flexGrow: 1,
      border: true,
      borderStyle: "single",
      borderColor: "#6b7280",
    });

    this.conversationView = new ScrollBoxRenderable(this.renderer, {
      id: "conversation-scroll",
      width: "100%",
      height: "100%",
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
    });

    this.conversationContent = new TextRenderable(this.renderer, {
      id: "conversation-content",
      content: "",
      width: "100%",
      wrapMode: "word",
    });
    this.updateConversationContent();

    this.conversationView.add(this.conversationContent);
    conversationBox.add(this.conversationView);

    // Input area
    const inputBox = new BoxRenderable(this.renderer, {
      id: "input-box",
      height: 3,
      border: true,
      borderStyle: "rounded",
      borderColor: "#22c55e",
      flexDirection: "row",
      padding: 0,
      paddingLeft: 1,
      paddingRight: 1,
      gap: 1,
    });

    const promptLabel = new TextRenderable(this.renderer, {
      id: "prompt-label",
      content: ">",
      width: 2,
    });

    this.inputField = new InputRenderable(this.renderer, {
      id: "input-field",
      placeholder: "Type your message...",
      flexGrow: 1,
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
    });

    // Handle Enter key to submit
    this.inputField.on(InputRenderableEvents.ENTER, () => {
      this.handleSubmit();
    });

    inputBox.add(promptLabel);
    inputBox.add(this.inputField);

    // Status bar
    this.statusText = new TextRenderable(this.renderer, {
      id: "status",
      content: `Connected to ${SERVER_URL}`,
      height: 1,
    });

    // Assemble layout
    root.add(header);
    root.add(conversationBox);
    root.add(inputBox);
    root.add(this.statusText);

    this.renderer.root.add(root);
  }

  /**
   * Handle user submission
   */
  private async handleSubmit(): Promise<void> {
    if (!this.inputField || this.state.isStreaming) return;

    const userInput = this.inputField.value.trim();
    if (!userInput) return;

    // Clear input
    this.inputField.value = "";

    // Add user message to state
    this.state.messages.push({ role: "user", content: userInput });

    // Display user message
    this.appendToConversation(`\nYou: ${userInput}\n`);

    // Start streaming
    this.state.isStreaming = true;
    this.state.currentAssistantContent = "";
    this.state.isInReasoning = false;
    this.updateStatus("Streaming...");

    try {
      await this.streamChat();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.appendToConversation(`\n❌ Error: ${errorMsg}\n`);
    } finally {
      // Add assistant message to state
      if (this.state.currentAssistantContent) {
        this.state.messages.push({
          role: "assistant",
          content: this.state.currentAssistantContent,
        });
      }

      this.state.isStreaming = false;
      this.state.currentAssistantContent = "";
      this.updateStatus(`Connected to ${SERVER_URL}`);

      // Re-focus input
      this.inputField?.focus();
    }
  }

  /**
   * Stream chat from the server using SSE
   */
  private async streamChat(): Promise<void> {
    const response = await fetch(`${SERVER_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: this.state.messages,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let isFirstText = true;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const events = this.parseSSE(buffer);
        buffer = events.remaining;

        for (const event of events.parsed) {
          this.handleEvent(event, isFirstText);
          if (event.type === "text") {
            isFirstText = false;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Ensure newline after response
    this.appendToConversation("\n");
  }

  /**
   * Parse SSE format from buffer
   */
  private parseSSE(buffer: string): { parsed: ServerEvent[]; remaining: string } {
    const parsed: ServerEvent[] = [];
    const lines = buffer.split("\n");
    let eventType = "";
    let data = "";
    let remaining = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Check if we have an incomplete event at the end
      if (i === lines.length - 1 && line !== "") {
        // This line might be incomplete, keep it in the buffer
        remaining = line;
        continue;
      }

      if (line.startsWith("event: ")) {
        eventType = line.slice(7);
      } else if (line.startsWith("data: ")) {
        data = line.slice(6);
      } else if (line === "" && data) {
        // Empty line signals end of event
        try {
          const event = JSON.parse(data) as ServerEvent;
          parsed.push(event);
        } catch {
          // Skip invalid JSON
        }
        eventType = "";
        data = "";
      }
    }

    // If we have partial data at the end, keep it
    if (eventType || data) {
      remaining = "";
      if (eventType) remaining += `event: ${eventType}\n`;
      if (data) remaining += `data: ${data}\n`;
    }

    return { parsed, remaining };
  }

  /**
   * Handle a parsed server event
   */
  private handleEvent(event: ServerEvent, isFirstText: boolean): void {
    switch (event.type) {
      case "text":
        // Start assistant response on first text
        if (isFirstText) {
          this.appendToConversation("\n", false);
        }
        this.appendToConversation(event.content, false);
        this.state.currentAssistantContent += event.content;
        break;

      case "reasoning":
        // Add newline before first reasoning chunk
        if (!this.state.isInReasoning) {
          this.appendToConversation("\n", false);
          this.state.isInReasoning = true;
        }
        this.appendToConversation(event.content, true);
        break;

      case "tool_call": {
        const inputStr =
          typeof event.input === "string" ? event.input : JSON.stringify(event.input);
        this.appendToConversation(`\n🔧 ${event.name}: ${inputStr}\n`);
        break;
      }

      case "tool_result": {
        const outputStr = this.formatOutput(event.output);
        this.appendToConversation(`   ↳ ${outputStr}\n`);
        break;
      }

      case "error":
        this.appendToConversation(`\n❌ Error: ${event.message}\n`);
        break;
    }
  }

  /**
   * Format tool output for display
   */
  private formatOutput(output: unknown): string {
    const str = JSON.stringify(output, null, 2);
    const lines = str.split("\n");
    if (lines.length <= 6) return str;
    return lines.slice(0, 5).join("\n") + `\n... (${lines.length - 5} more lines)`;
  }

  /**
   * Append text to the conversation view
   */
  private appendToConversation(text: string, isReasoning: boolean = false): void {
    // Try to merge with last segment if same type
    const lastSegment = this.contentSegments[this.contentSegments.length - 1];
    if (lastSegment && lastSegment.isReasoning === isReasoning) {
      lastSegment.text += text;
    } else {
      this.contentSegments.push({ text, isReasoning });
    }
    this.updateConversationContent();
  }

  /**
   * Rebuild and update the conversation content with styling
   */
  private updateConversationContent(): void {
    if (!this.conversationContent) return;

    // Build StyledText by concatenating chunks from each segment
    const allChunks = this.contentSegments.flatMap((segment) => {
      const styledSegment = segment.isReasoning
        ? t`${dim(italic(segment.text))}`
        : t`${segment.text}`;
      return styledSegment.chunks;
    });

    this.conversationContent.content = new StyledText(allChunks);
  }

  /**
   * Update status bar
   */
  private updateStatus(text: string): void {
    if (this.statusText) {
      this.statusText.content = text;
    }
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.renderer?.destroy();
    this.renderer = null;
  }
}

// Entry point
async function main(): Promise<void> {
  const client = new CliClient();

  try {
    await client.start();
  } catch (error) {
    console.error("Failed to start CLI client:", error);
    client.destroy();
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}

export { CliClient };
