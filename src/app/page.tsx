"use client";

import { useState, useRef, useEffect, FormEvent } from "react";
import MarkdownRenderer from "@/components/MarkdownRenderer";

type AppMode =
  | "gatekeeper"
  | "context-builder"
  | "sop-refinery"
  | "horizontal";

// Gatekeeper chat modes for the Tri-Bot state machine
type ChatMode = "select" | "diagnostic" | "support" | "enterprise" | "faq";

interface Message {
  role: "user" | "assistant" | "system-boundary";
  content: string;
  chips?: string[];
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [terminated, setTerminated] = useState(false);
  const [mode, setMode] = useState<AppMode | undefined>(undefined);
  const [activeSOP, setActiveSOP] = useState<string | null>(null);
  const [inventory, setInventory] = useState<string[]>([]);
  const [chatMode, setChatMode] = useState<ChatMode>("select");
  const [initialized, setInitialized] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const isTenant = process.env.NEXT_PUBLIC_INSTANCE_MODE === "tenant";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Premium auto-start: tenant instances bypass the front door via API lookup
  useEffect(() => {
    async function initSystem() {
      if (isTenant && !initialized) {
        setInitialized(true);
        setChatMode("diagnostic"); // Skip the select screen
        
        try {
          const res = await fetch("/api/init");
          const data = await res.json();
          if (data.inventory) {
            setInventory(data.inventory);
          }
          if (data.hasConstraints) {
            setMode("horizontal");
            // Suppress the initial ping, just load the hub instantly.
          } else {
            sendMessage("_init_");
          }
        } catch (e) {
          console.error(e);
          sendMessage("_init_"); // Fallback
        }
      }
    }
    initSystem();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendMessage(text: string, overrideChatMode?: ChatMode) {
    if ((!text.trim() && text !== "_init_") || loading) return;
    // Allow sending in terminated state only during FAQ pivot
    if (terminated && overrideChatMode !== "faq") return;

    const currentChatMode = overrideChatMode || chatMode;
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
    } else if (/^\[?Extract SOP:/i.test(text.trim())) {
      // Visual: transition immediately to Refinery room so UI changes rooms on click.
      // API: must send 'horizontal' so backend intercept detectExtractSOPTrigger() fires.
      // Regex allows both "Extract SOP: X" and "[Extract SOP: X]" chip formats.
      const taskName = text.trim().replace(/^\[?Extract SOP:\s*/i, "").replace(/\]$/, "");
      nextMode = "sop-refinery"; // Visual state — updates UI immediately
      nextActiveSOP = null;
      transitionMessages = [
        {
          role: "system-boundary",
          content: `SOP Extraction: ${taskName}. Refinery Active.`,
        },
      ];
    } else if (text.trim().startsWith("Load SOP:")) {
      // Dashboard UI trigger to jump directly into Step 4 Refinement
      const taskName = text.trim().replace(/^Load SOP:\s*/, "");
      nextMode = "horizontal";
      nextActiveSOP = taskName;
      transitionMessages = [
        {
          role: "system-boundary",
          content: `Loaded: ${taskName}. Refinement Workspace Active.`,
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

    // Capture brain dump BEFORE history truncation — needed for Extract SOP context handoff.
    // Room Isolation: only grab messages from the CURRENT room (after last system-boundary),
    // to avoid flooding the Refinery with the entire 22-message Calibration history.
    const lastBoundaryIndex = messages.map(m => m.role).lastIndexOf("system-boundary");
    const roomMessages = lastBoundaryIndex >= 0 ? messages.slice(lastBoundaryIndex + 1) : messages;

    const brainDumpContext = roomMessages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

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

    // For Extract SOP chip clicks: send 'horizontal' to the backend so the intercept fires,
    // even though the visual mode has already flipped to 'sop-refinery' above.
    const isExtractSOPTrigger = /^\[?Extract SOP:/i.test(text.trim());
    const modeForAPI = isExtractSOPTrigger ? "horizontal" : nextMode;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          mode: modeForAPI,
          activeSOP: nextActiveSOP,
          chatMode: currentChatMode,
          // Pass prior triage context so Refinery has background for its questions
          ...(isExtractSOPTrigger && brainDumpContext.length > 0
            ? { brainDump: brainDumpContext }
            : {}),
        }),
      });

      const data = await res.json();

      const assistantMessage: Message = {
        role: "assistant",
        content: data.message,
        chips: data.chips || [],
      };

      setMessages([...historyForDisplay, assistantMessage]);

      // Update mode from backend response
      if (data.mode) setMode(data.mode);
      if (data.activeSOP) setActiveSOP(data.activeSOP);
      if (data.nextMode) setMode(data.nextMode);
      if (data.terminated) setTerminated(true);
      if (data.inventory) setInventory(data.inventory);

      // Phase 2 → 3 transition: insert boundary when constraints are saved
      if (data.constraintsSaved) {
        setMessages((prev) => [
          ...prev,
          {
            role: "system-boundary" as const,
            content: "Initialization Complete. Workspace Active.",
          },
        ]);
        // Auto-handoff: silently fire workspace greeting to eliminate dead air
        setTimeout(() => {
          sendMessage("Workspace ready. What are we building today?");
        }, 0);
      }

      // Render the successfully saved SOP directly
      if (data.document_content) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.document_content }
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
    } else if (chip === "Start using lVl now") {
      // Persistent closer chip — opens Stripe payment link
      const stripeLink = process.env.NEXT_PUBLIC_STRIPE_PAYMENT_LINK || "#";
      window.open(stripeLink, "_blank", "noopener,noreferrer");
    } else {
      sendMessage(chip);
    }
  }

  // --- Tri-Bot Front Door: mode selection ---
  function handleModeSelect(selectedMode: ChatMode) {
    setChatMode(selectedMode);
    // Auto-send an opening message to kick off the selected mode
    if (selectedMode === "diagnostic") {
      sendMessage("Turn ideas into systems", selectedMode);
    } else if (selectedMode === "support") {
      sendMessage("Support & Feedback", selectedMode);
    } else if (selectedMode === "enterprise") {
      sendMessage("Enterprise Inquiry", selectedMode);
    }
  }

  // --- FAQ Escape Hatch: pivot from paywall to FAQ mode ---
  function handleFAQPivot() {
    setChatMode("faq");
    setTerminated(false);
    // Send a hidden trigger message to kick off the FAQ mode
    sendMessage("I have a few questions before moving forward.", "faq");
  }

  // Get chips from the last assistant message
  const lastMessage = messages[messages.length - 1];
  const lastAssistantChips =
    lastMessage?.role === "assistant" && !terminated && lastMessage.chips
      ? lastMessage.chips
      : [];

  // --- Hub Document Loading Logic ---
  async function handleLoadSOP(name: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/documents?name=${encodeURIComponent(name)}`);
      const data = await res.json();
      if (data.content) {
        setMessages([
          { role: "system-boundary", content: `Loaded: ${name}. Refinement Workspace Active.` },
          { role: "assistant", content: data.content }
        ]);
        setActiveSOP(name);
        setMode("horizontal");
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteSOP(name: string) {
    if (!window.confirm(`Delete ${name}?`)) return;
    try {
      const res = await fetch(`/api/documents?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.inventory) {
        setInventory(data.inventory);
      }
    } catch (e) {
      console.error(e);
    }
  }

  // --- Front Door & Hub View State Check ---
  const showFrontDoor = !isTenant && chatMode === "select" && messages.length === 0;

  return (
    <main className="relative flex flex-col h-full overflow-hidden bg-black">
      {/* Header */}
      <header className="px-6 py-4 flex justify-between items-center bg-[#0a0a0a] border-b border-[#1a1a1a]">
        <h1 
          className="text-white text-xl tracking-widest font-semibold cursor-pointer" 
          onClick={() => { setMessages([]); setActiveSOP(null); setMode("horizontal"); }}
        >
          lVl
        </h1>
        <div className="flex items-center gap-4">
          {!isTenant && (
            <a
              href={process.env.NEXT_PUBLIC_STRIPE_PAYMENT_LINK || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#878681] text-[10px] uppercase tracking-widest hover:text-white transition-colors duration-300"
            >
              [Get lVl OS]
            </a>
          )}
          {isTenant && mode !== "context-builder" && !showFrontDoor && (
            <button 
              onClick={() => { setMessages([]); setActiveSOP(null); setMode("horizontal"); }} 
              className="text-xs text-[#878681] tracking-widest uppercase hover:text-white transition-colors"
            >
              [Return to Hub]
            </button>
          )}
          {process.env.NEXT_PUBLIC_INSTANCE_MODE === "tenant" && (
            <a
              href="https://billing.stripe.com/p/login/dRm28q74m0ar6OA9rZ7N600"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#333333] text-[10px] uppercase tracking-widest hover:text-[#878681] transition-colors duration-300"
            >
              [Manage]
            </a>
          )}
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {/* Front Door Greeting */}
        {showFrontDoor && !loading && (
          <p className="text-[#878681] text-sm">
            lVl OS terminal active. Select your objective.
          </p>
        )}

        {/* Saved SOP Chips — Vanish once chat has messages */}
        {!showFrontDoor && messages.length === 0 && !loading && mode === "horizontal" && !activeSOP && inventory.length > 0 && (
          <div className="flex flex-wrap gap-3 pb-4 border-b border-[#1a1a1a]">
            {inventory.map((sopName) => (
              <span key={sopName} className="inline-flex items-center gap-1">
                <button
                  onClick={() => handleLoadSOP(sopName)}
                  className="text-[#878681] text-sm hover:text-white transition-colors duration-150 cursor-pointer"
                >
                  [{sopName}]
                </button>
                <button
                  onClick={() => handleDeleteSOP(sopName)}
                  className="text-[#555] text-xs hover:text-red-500 transition-colors duration-150 cursor-pointer leading-none"
                  title={`Delete ${sopName}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Normal empty state for tenant modes */}
        {!showFrontDoor && messages.length === 0 && !loading && (
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
            // Filter invisible init trigger from chat render
            if (msg.content === "_init_") return null;
            return (
              <p key={i} className="text-white text-sm">
                {msg.content}
              </p>
            );
          }

          // Assistant: render body directly natively
          return (
            <div key={i}>
              <MarkdownRenderer content={msg.content} />
            </div>
          );
        })}

        {loading && <p className="text-[#878681] text-sm">...</p>}

        <div ref={bottomRef} />
      </div>

      {/* Front Door Chips (Tri-Bot Selector) */}
      {showFrontDoor && !loading && (
        <div className="px-6 pb-2 flex flex-wrap gap-3">
          <button
            onClick={() => handleModeSelect("diagnostic")}
            className="text-[#878681] text-sm hover:text-white transition-colors duration-150 cursor-pointer"
          >
            [Turn ideas into systems]
          </button>
          <button
            onClick={() => handleModeSelect("support")}
            className="text-[#878681] text-sm hover:text-white transition-colors duration-150 cursor-pointer"
          >
            [Support & Feedback]
          </button>
          <button
            onClick={() => handleModeSelect("enterprise")}
            className="text-[#878681] text-sm hover:text-white transition-colors duration-150 cursor-pointer"
          >
            [Enterprise Inquiry]
          </button>
        </div>
      )}

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
          <button
            onClick={handleFAQPivot}
            className="w-full text-center py-3 border border-[#333] text-[#878681] text-sm tracking-wide hover:text-white hover:border-[#555] transition-colors duration-150 cursor-pointer"
          >
            I have a few questions
          </button>
        </div>
      )}

      {/* Quick Chips (non-terminated) */}
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



      {/* Input (hidden when terminated or on front door) */}
      {!terminated && !showFrontDoor && (
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
