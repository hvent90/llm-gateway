/**
 * LLM Gateway CLI Client
 *
 * Interactive terminal-based client for the LLM Gateway server.
 * Uses @opentui/solid for rendering a rich terminal interface with
 * fine-grained reactivity for efficient updates during streaming.
 */

import { render } from "@opentui/solid"
import { createSignal, For, Show, onCleanup } from "solid-js"

// Configuration from environment
const MODEL = process.env.LLM_MODEL ?? "nvidia/nemotron-nano-9b-v2:free"
const SERVER_URL = process.env.LLM_GATEWAY_URL ?? "http://localhost:4000"

// Message types
interface Message {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  isReasoning?: boolean
}

// Server event types
type ServerEvent =
  | { type: "connected"; sessionId: string }
  | { type: "text"; runId: string; id: string; content: string }
  | { type: "reasoning"; runId: string; id: string; content: string }
  | { type: "tool_call"; runId: string; id: string; name: string; input: unknown }
  | { type: "tool_result"; runId: string; id: string; output: unknown }
  | {
      type: "permission_required"
      runId: string
      toolCallId: string
      tool: string
      params: Record<string, unknown>
    }
  | { type: "error"; runId: string; message: string }

// Permission request
interface PermissionRequest {
  toolCallId: string
  tool: string
  params: Record<string, unknown>
}

// Generate unique IDs
let idCounter = 0
function generateId(): string {
  return `msg-${++idCounter}`
}

// Message component - only re-renders when THIS message changes
function MessageView(props: { message: Message }) {
  return (
    <text
      wrapMode="word"
      color={props.message.isReasoning ? "gray" : undefined}
      italic={props.message.isReasoning}
    >
      {props.message.role === "user" ? "You: " : ""}
      {props.message.content}
    </text>
  )
}

// Main App Component
function ChatApp() {
  const [messages, setMessages] = createSignal<Message[]>([
    { id: generateId(), role: "system", content: "Welcome! Type a message and press Enter to start chatting.\n" },
  ])
  const [isStreaming, setIsStreaming] = createSignal(false)
  const [currentStreamContent, setCurrentStreamContent] = createSignal("")
  const [isCurrentlyReasoning, setIsCurrentlyReasoning] = createSignal(false)
  const [inputValue, setInputValue] = createSignal("")
  const [statusText, setStatusText] = createSignal(`Connected to ${SERVER_URL}`)
  const [sessionId, setSessionId] = createSignal<string | null>(null)
  const [pendingPermission, setPendingPermission] = createSignal<PermissionRequest | null>(null)

  // Track current assistant content for state management
  let currentAssistantContent = ""

  // Format tool output for display
  function formatOutput(output: unknown): string {
    const str = JSON.stringify(output, null, 2)
    const lines = str.split("\n")
    if (lines.length <= 6) return str
    return lines.slice(0, 5).join("\n") + `\n... (${lines.length - 5} more lines)`
  }

  // Add a message to the conversation
  function addMessage(role: Message["role"], content: string, isReasoning = false) {
    setMessages((prev) => [...prev, { id: generateId(), role, content, isReasoning }])
  }

  // Parse SSE format from buffer
  function parseSSE(buffer: string): { parsed: ServerEvent[]; remaining: string } {
    const parsed: ServerEvent[] = []
    const lines = buffer.split("\n")
    let data = ""
    let remaining = ""

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!

      // Check if we have an incomplete event at the end
      if (i === lines.length - 1 && line !== "") {
        remaining = line
        continue
      }

      if (line.startsWith("event: ")) {
        // Event type line - just consume it
      } else if (line.startsWith("data: ")) {
        data = line.slice(6)
      } else if (line === "" && data) {
        try {
          const event = JSON.parse(data) as ServerEvent
          parsed.push(event)
        } catch {
          // Skip invalid JSON
        }
        data = ""
      }
    }

    // If we have partial data at the end, keep it
    if (data) {
      remaining = `data: ${data}\n`
    }

    return { parsed, remaining }
  }

  // Handle a parsed server event
  function handleEvent(event: ServerEvent, isFirstText: { value: boolean }) {
    switch (event.type) {
      case "connected":
        setSessionId(event.sessionId)
        break

      case "text":
        if (isFirstText.value) {
          setCurrentStreamContent("\n")
          isFirstText.value = false
        }
        setCurrentStreamContent((prev) => prev + event.content)
        currentAssistantContent += event.content
        break

      case "reasoning":
        if (!isCurrentlyReasoning()) {
          // Start new reasoning block
          setIsCurrentlyReasoning(true)
          setCurrentStreamContent((prev) => prev + "\n")
        }
        setCurrentStreamContent((prev) => prev + event.content)
        break

      case "tool_call": {
        const inputStr = typeof event.input === "string" ? event.input : JSON.stringify(event.input)
        addMessage("assistant", `\n[tool] ${event.name}: ${inputStr}\n`)
        break
      }

      case "tool_result": {
        const outputStr = formatOutput(event.output)
        addMessage("assistant", `   -> ${outputStr}\n`)
        break
      }

      case "permission_required":
        setPendingPermission({
          toolCallId: event.toolCallId,
          tool: event.tool,
          params: event.params,
        })
        showPermissionPrompt(event.tool, event.params)
        break

      case "error":
        addMessage("assistant", `\n[error] ${event.message}\n`)
        break
    }
  }

  // Show permission prompt
  function showPermissionPrompt(tool: string, params: Record<string, unknown>) {
    const paramsStr = JSON.stringify(params, null, 2)
    addMessage("system", `\n[!] Permission Required\n   Tool: ${tool}\n   Params: ${paramsStr}\n   Enter 'y' to allow, 'n' to deny\n`)
    setStatusText("[!] Permission required - awaiting response")
  }

  // Resolve a pending permission request
  async function resolvePermission(approved: boolean) {
    const permission = pendingPermission()
    const session = sessionId()
    if (!permission || !session) {
      addMessage("system", `\n[error] No pending permission or session\n`)
      return
    }

    const { toolCallId } = permission
    const reason = approved ? undefined : "User denied"

    try {
      const response = await fetch(`${SERVER_URL}/chat/permission/${toolCallId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session,
          approved,
          reason,
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      addMessage("system", `\n${approved ? "[ok] Allowed" : "[x] Denied"}\n`)
      setPendingPermission(null)
      setStatusText("Streaming...")
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      addMessage("system", `\n[error] Failed to resolve permission: ${errorMsg}\n`)
    }
  }

  // Stream chat from the server using SSE
  async function streamChat(userMessages: Array<{ role: string; content: string }>) {
    const response = await fetch(`${SERVER_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: userMessages,
      }),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    if (!response.body) {
      throw new Error("No response body")
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const isFirstText = { value: true }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Parse SSE events
        const events = parseSSE(buffer)
        buffer = events.remaining

        for (const event of events.parsed) {
          handleEvent(event, isFirstText)
        }
      }
    } finally {
      reader.releaseLock()
    }

    // Add newline after response
    setCurrentStreamContent((prev) => prev + "\n")
  }

  // Handle user submission
  async function handleSubmit(value: string) {
    const userInput = value.trim()
    if (!userInput) return

    // Clear input
    setInputValue("")

    // Handle permission response if pending
    const permission = pendingPermission()
    if (permission) {
      const normalized = userInput.toLowerCase()
      const isApprove = ["y", "yes", "allow", "a"].includes(normalized)
      const isDeny = ["n", "no", "deny", "d"].includes(normalized)

      if (isApprove || isDeny) {
        await resolvePermission(isApprove)
        return
      }
      // Invalid response, prompt again
      addMessage("system", `\n[!] Please enter 'y' to allow or 'n' to deny.\n`)
      return
    }

    if (isStreaming()) return

    // Add user message to display
    addMessage("user", userInput + "\n")

    // Start streaming
    setIsStreaming(true)
    setCurrentStreamContent("")
    setIsCurrentlyReasoning(false)
    currentAssistantContent = ""
    setStatusText("Streaming...")

    // Build messages array for API (excluding system messages and reasoning)
    const apiMessages = messages()
      .filter((m) => m.role !== "system" && !m.isReasoning)
      .map((m) => ({ role: m.role, content: m.content }))

    try {
      await streamChat(apiMessages)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      addMessage("system", `\n[error] ${errorMsg}\n`)
    } finally {
      // Finalize streamed content as a message
      const streamedContent = currentStreamContent()
      if (streamedContent.trim()) {
        addMessage("assistant", streamedContent, isCurrentlyReasoning())
      }

      setIsStreaming(false)
      setCurrentStreamContent("")
      setIsCurrentlyReasoning(false)
      currentAssistantContent = ""
      setStatusText(`Connected to ${SERVER_URL}`)
    }
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Header */}
      <box height={3} border borderStyle="rounded" borderColor="#3b82f6" paddingLeft={1} paddingRight={1}>
        <text>LLM Gateway CLI  |  Model: {MODEL}</text>
      </box>

      {/* Messages - each is its own reactive text node */}
      <box flexGrow={1} border borderStyle="single" borderColor="#6b7280">
        <scrollbox width="100%" height="100%" scrollY stickyScroll stickyStart="bottom">
          <For each={messages()}>{(msg) => <MessageView message={msg} />}</For>
          <Show when={isStreaming()}>
            <text
              wrapMode="word"
              color={isCurrentlyReasoning() ? "gray" : undefined}
              italic={isCurrentlyReasoning()}
            >
              {currentStreamContent()}
            </text>
          </Show>
        </scrollbox>
      </box>

      {/* Input */}
      <box
        height={3}
        border
        borderStyle="rounded"
        borderColor="#22c55e"
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        gap={1}
      >
        <text width={2}>{">"}</text>
        <input
          flexGrow={1}
          value={inputValue()}
          onInput={setInputValue}
          onSubmit={handleSubmit}
          placeholder="Type your message..."
          focused
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
        />
      </box>

      {/* Status bar */}
      <text height={1}>{statusText()}</text>
    </box>
  )
}

// Entry point
render(() => <ChatApp />)
