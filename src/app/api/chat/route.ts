import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { GATEKEEPER_PROMPT } from "@/lib/prompts/gatekeeper";
import { getContextBuilderPrompt } from "@/lib/prompts/context-builder";
import { SOP_REFINERY_PROMPT } from "@/lib/prompts/sop-refinery";
import { HORIZONTAL_PROMPT } from "@/lib/prompts/horizontal";
import {
    saveConstraintsDocument,
    loadConstraintsDocument,
    saveSOP,
    loadSOP,
    listSOPs,
    getMostRecentSOP,
} from "@/lib/storage";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const INSTANCE_MODE = process.env.INSTANCE_MODE || "gatekeeper";

// --- Rate Limiter (protects Gatekeeper on public Vercel) ---
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10; // max requests per window per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

// Clean stale entries every 60s to prevent memory leak
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
}, 60_000);

function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return true; // allowed
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX;
}

type AppMode = "gatekeeper" | "context-builder" | "sop-refinery" | "horizontal";

interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string;
}

interface ChatRequest {
    messages: ChatMessage[];
    mode?: AppMode;
    activeSOP?: string;
}

// --- Utility: Strip AI-generated CHIPS from a message ---
function stripChips(text: string): string {
    return text.replace(/CHIPS:\s*.+$/m, "").trimEnd();
}

// --- Utility: Detect "Extract SOP:" trigger in the latest user message ---
function detectExtractSOPTrigger(messages: ChatMessage[]): string | null {
    if (messages.length === 0) return null;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return null;
    const match = lastUserMsg.content.match(/^Extract SOP:\s*(.+)$/i);
    return match ? match[1].trim() : null;
}

// ============================================================
// GATEKEEPER MODE (Vercel — public sales bot)
// ============================================================

function buildTerminalPitch(): NextResponse {
    const starterLink = process.env.STRIPE_LINK_STARTER || "#";
    const proLink = process.env.STRIPE_LINK_PRO || "#";

    const pitch = [
        "I've heard enough. Your operation has a structural vulnerability — the SOPs are in your head, not in a system.",
        "",
        "lVl OS extracts those procedures through a guided AI process and turns them into documented, constraint-driven operational infrastructure your team can actually follow.",
        "",
        "Two paths forward:",
        "",
        `→ Starter: ${starterLink}`,
        `→ Pro: ${proLink}`,
        "",
        "Pick one. Or don't. Either way, that bottleneck isn't going to document itself.",
    ].join("\n");

    return NextResponse.json({
        message: pitch,
        turnCount: 5,
        terminated: true,
        mode: "gatekeeper" as AppMode,
    });
}

async function handleGatekeeper(messages: ChatMessage[]) {
    const userTurnCount = messages.filter((m) => m.role === "user").length;

    if (userTurnCount >= 5) {
        return buildTerminalPitch();
    }

    const windowedMessages = messages.slice(-10);

    const apiMessages: ChatMessage[] = [
        { role: "system", content: GATEKEEPER_PROMPT },
        ...windowedMessages,
    ];

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 100,
        messages: apiMessages,
    });

    return NextResponse.json({
        message: completion.choices[0]?.message?.content || "...",
        turnCount: userTurnCount,
        terminated: false,
        mode: "gatekeeper" as AppMode,
    });
}

// ============================================================
// CONTEXT BUILDER (no constraints.md yet)
// ============================================================

function extractConstraintsDocument(text: string): {
    cleanText: string;
    document: string | null;
} {
    const delimiter = "===CONSTRAINTS_DOCUMENT===";
    const parts = text.split(delimiter);

    if (parts.length >= 3) {
        const document = parts[1].trim();
        const cleanText =
            parts[0].trim() + (parts[2] ? "\n\n" + parts[2].trim() : "");
        return { cleanText: cleanText.trim(), document };
    }

    return { cleanText: text, document: null };
}

async function handleContextBuilder(messages: ChatMessage[]) {
    const systemPrompt = getContextBuilderPrompt();
    const windowedMessages = messages.slice(-10);

    const apiMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...windowedMessages,
    ];

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 2000,
        messages: apiMessages,
    });

    const rawResponse = completion.choices[0]?.message?.content || "...";
    const { cleanText, document } = extractConstraintsDocument(rawResponse);

    if (document) {
        saveConstraintsDocument(document);
        console.log("[lVl] Constraints Document saved.");
    }

    // --- Phase 2 → Phase 3 transition ---
    // When constraints are saved, append ignition chips for the Horizontal Workspace
    let finalMessage = cleanText;
    if (document) {
        finalMessage = stripChips(finalMessage);
        finalMessage += "\n\nCHIPS: [Initiate Daily Brain Dump] | [Extract a Specific Task]";
    }

    return NextResponse.json({
        message: finalMessage,
        turnCount: messages.filter((m) => m.role === "user").length,
        terminated: false,
        mode: "context-builder" as AppMode,
        constraintsSaved: !!document,
        ...(document ? { nextMode: "horizontal" as AppMode } : {}),
    });
}

// ============================================================
// SOP REFINERY (constraints.md exists, extraction triggered)
// ============================================================

function extractSOPDocument(text: string): {
    cleanText: string;
    document: string | null;
    sopName: string | null;
} {
    const delimiter = "===SOP_DOCUMENT===";
    const parts = text.split(delimiter);

    if (parts.length >= 3) {
        const document = parts[1].trim();
        const nameMatch = document.match(/^#\s*SOP:\s*(.+)$/m);
        const sopName = nameMatch ? nameMatch[1].trim() : "untitled";
        // FIX: Include the SOP document in the display text.
        // Strip the delimiters but KEEP the SOP content visible in chat.
        const cleanText =
            parts[0].trim() + "\n\n" + document + (parts[2] ? "\n\n" + parts[2].trim() : "");
        return { cleanText: cleanText.trim(), document, sopName };
    }

    return { cleanText: text, document: null, sopName: null };
}

async function handleSOPRefinery(
    messages: ChatMessage[],
    constraints: string,
    taskNameContext?: string
) {
    let systemPrompt = SOP_REFINERY_PROMPT.replace("{CONSTRAINTS}", constraints);

    // --- "Extract SOP:" trigger: inject task name context and skip S1 ---
    // If the user triggered extraction from Horizontal Mode via a dynamic chip,
    // we inject a system hint so the AI skips S1 and starts at S2.
    let apiMessages: ChatMessage[];

    if (taskNameContext) {
        const contextHint: ChatMessage = {
            role: "system",
            content: `The user has selected to extract the SOP for "${taskNameContext}". Acknowledge this, SKIP Section 1 (Procedure Name), and begin the extraction immediately with Section 2 (Purpose).`,
        };
        apiMessages = [
            { role: "system", content: systemPrompt },
            contextHint,
            ...messages,
        ];
        console.log(`[lVl] SOP Refinery triggered with context: ${taskNameContext}`);
    } else {
        // No sliding window for SOP Refinery — full message array passed
        apiMessages = [
            { role: "system", content: systemPrompt },
            ...messages,
        ];
    }

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 2000,
        messages: apiMessages,
    });

    const rawResponse = completion.choices[0]?.message?.content || "...";
    const { cleanText, document, sopName } = extractSOPDocument(rawResponse);

    let savedSOPName: string | null = null;
    if (document && sopName) {
        const safeName = sopName.replace(/[^a-zA-Z0-9_-]/g, "_");
        saveSOP(sopName, document);
        savedSOPName = safeName;
        console.log(`[lVl] SOP saved: ${sopName}`);
    }

    // Server-side chip stripping on compilation
    let finalMessage = cleanText;
    if (savedSOPName) {
        finalMessage = stripChips(finalMessage);
        finalMessage +=
            "\n\nCHIPS: [Enter Workspace to Refine This] | [Extract Another SOP]";
    }

    return NextResponse.json({
        message: finalMessage,
        turnCount: messages.filter((m) => m.role === "user").length,
        terminated: false,
        mode: "sop-refinery" as AppMode,
        sopSaved: !!document,
        activeSOP: savedSOPName,
    });
}

// ============================================================
// HORIZONTAL MODE (daily workspace — DEFAULT drop-in)
// ============================================================

async function handleHorizontal(
    messages: ChatMessage[],
    constraints: string,
    activeSOP: string | null
) {
    let prompt = HORIZONTAL_PROMPT.replace("{CONSTRAINTS}", constraints);

    // Inject active SOP context
    if (activeSOP) {
        const sopContent = loadSOP(activeSOP);
        if (sopContent) {
            const sopBlock = `--- ACTIVE SOP: ${activeSOP} ---\n${sopContent}\n--- END SOP ---`;
            prompt = prompt.replace("{ACTIVE_SOP_BLOCK}", sopBlock);
        } else {
            prompt = prompt.replace("{ACTIVE_SOP_BLOCK}", "No SOP loaded for this session.");
        }
    } else {
        prompt = prompt.replace("{ACTIVE_SOP_BLOCK}", "No SOP loaded. General workspace mode.");
    }

    // Inject SOP inventory for context grounding
    const existingSOPs = listSOPs();
    if (existingSOPs.length > 0) {
        const inventory = `--- SOP INVENTORY (${existingSOPs.length} files) ---\n${existingSOPs.map((f) => `- ${f}`).join("\n")}\n--- END INVENTORY ---`;
        prompt = prompt.replace("{SOP_INVENTORY}", inventory);
    } else {
        prompt = prompt.replace("{SOP_INVENTORY}", "No SOPs on file yet.");
    }

    // Sliding window: last 10 messages (token defense for daily use)
    const windowedMessages = messages.slice(-10);

    const apiMessages: ChatMessage[] = [
        { role: "system", content: prompt },
        ...windowedMessages,
    ];

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 2000,
        messages: apiMessages,
    });

    const rawResponse = completion.choices[0]?.message?.content || "...";

    // --- SOP Refinement: detect ===SOP_DOCUMENT=== from full document output ---
    const { cleanText, document, sopName } = extractSOPDocument(rawResponse);

    let savedSOPName: string | null = null;
    if (document && sopName) {
        const safeName = sopName.replace(/[^a-zA-Z0-9_-]/g, "_");
        saveSOP(sopName, document);
        savedSOPName = safeName;
        console.log(`[lVl] Refined SOP saved: ${sopName}`);
    }

    // Strip AI chips on SOP save, append refinement transition chips
    let finalMessage = cleanText;
    if (savedSOPName) {
        finalMessage = stripChips(finalMessage);
        finalMessage += "\n\nCHIPS: [Keep refining] | [Lock it] | [Extract another SOP]";
    }

    return NextResponse.json({
        message: finalMessage,
        turnCount: messages.filter((m) => m.role === "user").length,
        terminated: false,
        mode: "horizontal" as AppMode,
        activeSOP: savedSOPName || activeSOP,
        sopSaved: !!document,
    });
}

// ============================================================
// MAIN ROUTER
// ============================================================

function resolveMode(
    requestedMode: AppMode | undefined,
    constraints: string | null
): AppMode {
    if (INSTANCE_MODE === "gatekeeper") return "gatekeeper";

    // Trust explicit frontend mode echo
    if (requestedMode === "horizontal") return "horizontal";
    if (requestedMode === "sop-refinery") return "sop-refinery";

    // Infer from filesystem state
    if (!constraints) return "context-builder";

    // DEFAULT: Horizontal workspace when constraints exist
    return "horizontal";
}

export async function POST(req: NextRequest) {
    // --- Rate limit check (Gatekeeper only) ---
    if (INSTANCE_MODE === "gatekeeper") {
        const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
        if (!checkRateLimit(ip)) {
            return NextResponse.json(
                { message: "Rate limit exceeded. Try again in a minute.", turnCount: 0, terminated: false, mode: "gatekeeper" as AppMode },
                { status: 429 }
            );
        }
    }

    try {
        const body: ChatRequest = await req.json();
        const messages = body.messages || [];
        const requestedMode = body.mode;
        const activeSOP = body.activeSOP || null;

        const constraints = loadConstraintsDocument();
        let mode = resolveMode(requestedMode, constraints);

        // --- "Extract SOP:" trigger detection ---
        // If the user is in Horizontal mode and clicks a dynamic SOP extraction chip,
        // intercept it, flip the mode, and pass the task name as context.
        const extractTrigger = detectExtractSOPTrigger(messages);
        if (extractTrigger && mode === "horizontal") {
            console.log(`[lVl] Extract SOP trigger detected: "${extractTrigger}"`);
            mode = "sop-refinery";
            // Pass only the trigger message (fresh context for new extraction)
            return handleSOPRefinery(
                [{ role: "user", content: `Extract SOP: ${extractTrigger}` }],
                constraints!,
                extractTrigger
            );
        }

        switch (mode) {
            case "gatekeeper":
                return handleGatekeeper(messages);

            case "context-builder":
                return handleContextBuilder(messages);

            case "sop-refinery":
                return handleSOPRefinery(messages, constraints!);

            case "horizontal": {
                const sopToLoad = activeSOP || getMostRecentSOP();
                return handleHorizontal(messages, constraints!, sopToLoad);
            }

            default:
                return handleGatekeeper(messages);
        }
    } catch (error) {
        console.error("[lVl] API error:", error);
        return NextResponse.json(
            {
                message: "System error. Try again.",
                turnCount: 0,
                terminated: false,
                mode: INSTANCE_MODE as AppMode,
            },
            { status: 500 }
        );
    }
}
