"use client";

import { useState, useRef, useEffect, FormEvent } from "react";
import MarkdownRenderer from "@/components/MarkdownRenderer";

type AppMode =
  | "gatekeeper"
  | "context-builder"
  | "sop-refinery"
  | "horizontal";

interface Message {
  role: "user" | "assistant" | "system-boundary";
  content: string;
}

// --- Quick Chips Parser ---
function parseChips(text: string): { body: string; chips: string[] } {
  const chipMatch = text.match(/CHIPS:\s*(.+)$/m);
  if (!chipMatch) return { body: text, chips: [] };

  const body = text.replace(/CHIPS:\s*.+$/m, "").trimEnd();
  const chips = chipMatch[1]
    .split("|")
    .map((c) => c.trim().replace(/^\[|\]$/g, "").trim())
    .filter(Boolean);

  return { body, chips };
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [terminated, setTerminated] = useState(false);
  const [mode, setMode] = useState<AppMode | undefined>(undefined);
  const [activeSOP, setActiveSOP] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(text: string) {
    if (!text.trim() || loading || terminated) return;

    const userMessage: Message = { role: "user", content: text.trim() };

    // --- Mode Transition: Handle explicit mode switches ---
    let nextMode = mode;
    let nextActiveSOP = activeSOP;
    let transitionMessages: Message[] = [];

    if (text.trim() === "Enter Workspace to Refine This") {
      nextMode = "horizontal";
      transitionMessages = [
        {
          role: "system-boundary",
          content: "SOP Locked. Horizontal Workspace Active.",
        },
      ];
    } else if (text.trim() === "Extract Another SOP") {
      nextMode = "sop-refinery";
      nextActiveSOP = null;
      transitionMessages = [
        {
          role: "system-boundary",
          content: "New SOP Extraction. Refinery Active.",
        },
      ];
    } else if (text.trim() === "Start new SOP extraction") {
      nextMode = "sop-refinery";
      nextActiveSOP = null;
      transitionMessages = [
        {
          role: "system-boundary",
          content: "New SOP Extraction. Refinery Active.",
        },
      ];
    } else if (text.trim().startsWith("Extract SOP:")) {
      // Dynamic SOP extraction trigger from Horizontal Mode Brain Dump
      const taskName = text.trim().replace(/^Extract SOP:\s*/, "");
      nextMode = "sop-refinery";
      nextActiveSOP = null;
      transitionMessages = [
        {
          role: "system-boundary",
          content: `SOP Extraction: ${taskName}. Refinery Active.`,
        },
      ];
    } else if (text.trim() === "Extract a Specific Task") {
      // Direct launch of SOP Refinery from ignition chips (starts at S1)
      nextMode = "sop-refinery";
      nextActiveSOP = null;
      transitionMessages = [
        {
          role: "system-boundary",
          content: "New SOP Extraction. Refinery Active.",
        },
      ];
    }

    // If transitioning, truncate history. Otherwise preserve.
    const historyForDisplay =
      transitionMessages.length > 0
        ? [...transitionMessages, userMessage]
        : [...messages, userMessage];

    // Messages sent to the API: only user/assistant messages (no system-boundary)
    const apiMessages = historyForDisplay
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    setMessages(historyForDisplay);
    setInput("");
    setLoading(true);

    if (nextMode !== mode) {
      setMode(nextMode);
    }
    if (nextActiveSOP !== activeSOP) {
      setActiveSOP(nextActiveSOP);
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          mode: nextMode,
          activeSOP: nextActiveSOP,
        }),
      });

      const data = await res.json();

      const assistantMessage: Message = {
        role: "assistant",
        content: data.message,
      };

      setMessages([...historyForDisplay, assistantMessage]);

      // Update mode from backend response
      if (data.mode) setMode(data.mode);
      if (data.activeSOP) setActiveSOP(data.activeSOP);
      if (data.nextMode) setMode(data.nextMode);
      if (data.terminated) setTerminated(true);

      // Phase 2 → 3 transition: insert boundary when constraints are saved
      if (data.constraintsSaved) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system-boundary" as const,
            content: "Initialization Complete. Workspace Active.",
          },
        ]);
      }
    } catch {
      setMessages([
        ...historyForDisplay,
        { role: "assistant", content: "System error. Try again." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    sendMessage(input);
  }

  function handleChipClick(chip: string) {
    if (chip === "Skip ->") {
      sendMessage("Skip");
    } else {
      sendMessage(chip);
    }
  }

  // Get chips from the last assistant message
  const lastMessage = messages[messages.length - 1];
  const lastAssistantChips =
    lastMessage?.role === "assistant" && !terminated
      ? parseChips(lastMessage.content).chips
      : [];

  return (
    <main className="flex flex-col h-full overflow-hidden bg-black">
      {/* Header */}
      <header className="px-6 py-4">
        <h1 className="text-white text-sm tracking-widest">lVl</h1>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {messages.length === 0 && !loading && (
          <p className="text-[#878681] text-sm">
            Which idea are we turning into a system?
          </p>
        )}

        {messages.map((msg, i) => {
          // System boundary messages (mode transitions)
          if (msg.role === "system-boundary") {
            return (
              <div key={i} className="py-4 my-2 border-y border-[#1a1a1a]">
                <p className="text-[#878681] text-xs tracking-widest uppercase text-center">
                  SYSTEM: {msg.content}
                </p>
              </div>
            );
          }

          if (msg.role === "user") {
            return (
              <p key={i} className="text-white text-sm">
                {msg.content}
              </p>
            );
          }

          // Assistant: parse chips out, render body via Markdown
          const { body } = parseChips(msg.content);
          return (
            <div key={i}>
              <MarkdownRenderer content={body} />
            </div>
          );
        })}

        {loading && <p className="text-[#878681] text-sm">...</p>}

        <div ref={bottomRef} />
      </div>

      {/* Paywall CTAs (Gatekeeper Turn 5) */}
      {terminated && (
        <div className="px-6 py-6 border-t border-[#1a1a1a] flex flex-col gap-3">
          <a
            href={process.env.NEXT_PUBLIC_STRIPE_PAYMENT_LINK || "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-center py-3 bg-white text-black text-sm font-semibold tracking-wide hover:bg-[#e0e0e0] transition-colors duration-150"
          >
            Deploy My Private Instance →
          </a>
          <a
            href="https://ig.me/m/lvl_space.to.begin_"
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-center py-3 border border-[#333] text-[#878681] text-sm tracking-wide hover:text-white hover:border-[#555] transition-colors duration-150"
          >
            I have a few questions
          </a>
        </div>
      )}

      {/* Quick Chips (non-terminated only) */}
      {!terminated && lastAssistantChips.length > 0 && !loading && (
        <div className="px-6 pb-2 flex flex-wrap gap-3">
          {lastAssistantChips.map((chip, i) => (
            <button
              key={i}
              onClick={() => handleChipClick(chip)}
              className="text-[#878681] text-sm hover:text-white transition-colors duration-150 cursor-pointer"
            >
              [{chip}]
            </button>
          ))}
        </div>
      )}

      {/* Input (hidden when terminated) */}
      {!terminated && (
        <form
          onSubmit={handleSubmit}
          className="px-6 py-4 border-t border-[#1a1a1a]"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
            placeholder="speak. create. refine"
            className="w-full bg-transparent text-white text-sm outline-none placeholder-[#878681] disabled:opacity-30"
            autoFocus
          />
        </form>
      )}
    </main>
  );
}
