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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "dummy-key-for-build" });
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
    chatMode?: "select" | "diagnostic" | "support" | "enterprise" | "faq";
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

async function buildTerminalPitch(messages: ChatMessage[]): Promise<NextResponse> {
    const pitchPrompt = `You are the lVl OS diagnostic closer. The user just completed a 4-turn diagnostic. You have the FULL conversation history below.

Your task has TWO parts:

PART 1 — THE DIAGNOSIS (3 short paragraphs):
1. Paragraph 1: State the core diagnosis. Mirror their exact language back to them. Name the pattern you identified.
2. Paragraph 2: Explain what lVl OS does — it extracts procedures through guided conversation and turns them into documented, constraint-driven systems.
3. Paragraph 3: Transition line: "Here is what your first extracted system would look like:"

PART 2 — THE PREVIEW SYSTEM (Operational Document):
Based STRICTLY on what the user revealed in the conversation, generate a highly specific, professional operational document. This is a proof-of-concept — show the user that lVl already understands their problem well enough to start building.

Format the document exactly like this:
---
**SOP Preview: [Specific Task Name Based on Their Pain Point]**

**Objective:** [One clear sentence defining the goal of this system]

**Known Blockers:** [2-3 bullet points listing the specific friction points the user revealed in the chat]

**Operating Constraints:** [2-3 bullet points defining the hard rules required to make this work — things that must always be true]

**Execution Protocol:**
1. [Concrete, actionable directive — not a suggestion, a command]
2. [Concrete, actionable directive]
3. [Concrete, actionable directive]
---

Then end with exactly this line on its own:
"**This is one system. lVl OS extracts dozens. Deploy your private instance below to start building.**"

CRITICAL ADAPTATION:
- If the diagnostic was about a BUSINESS OPERATION, use words like "operation," "team," "procedures," "staff."
- If the diagnostic was about a PERSONAL FRAMEWORK, use words like "system," "routine," "framework," "habits," "accountability." Do NOT say "team" or "operation."
- If it was BOTH, blend the language naturally.

Start with "Diagnosis complete." on its own line. Be clinical. No warmth. No sales language. The document must be specific enough to feel custom-built, not generic.`;

    const apiMessages: ChatMessage[] = [
        { role: "system", content: pitchPrompt },
        ...messages.slice(-10),
    ];

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 800,
        messages: apiMessages,
    });

    return NextResponse.json({
        message: completion.choices[0]?.message?.content || "Diagnosis complete.\n\nlVl OS extracts your procedures through guided conversation and turns them into documented, constraint-driven systems.\n\n**To translate this diagnosis into an executable system, deploy your private instance below.**",
        turnCount: 5,
        terminated: true,
        mode: "gatekeeper" as AppMode,
    });
}

async function handleGatekeeper(messages: ChatMessage[]) {
    const userTurnCount = messages.filter((m) => m.role === "user").length;

    // --- FAST LANE: High buying intent override ---
    // If user explicitly asks to pay at any turn, skip straight to Turn 5 pitch
    const lastUserMsg = messages.filter((m) => m.role === "user").pop();
    if (lastUserMsg) {
        const intent = lastUserMsg.content.toLowerCase();
        const buySignals = [
            "take my money", "where do i pay", "sign up", "ready to buy",
            "payment link", "shut up and take", "how do i start",
            "i want to start", "let me pay", "give me the link",
            "i'm ready", "im ready", "i'm sold", "im sold",
            "how much", "what does it cost", "pricing", "subscribe",
            "start using lvl", "deploy my", "get started",
        ];
        if (buySignals.some((signal) => intent.includes(signal))) {
            console.log(`[lVl] FAST LANE triggered at turn ${userTurnCount}: "${lastUserMsg.content}"`);
            return buildTerminalPitch(messages);
        }
    }

    if (userTurnCount >= 5) {
        return buildTerminalPitch(messages);
    }

    // Inject turn count so the AI knows when to deliver final diagnosis
    const turnAwarePrompt = GATEKEEPER_PROMPT + OFF_TOPIC_GUARDRAIL + `\n\n[SYSTEM: This is the user's turn ${userTurnCount + 1} of 4. ${userTurnCount >= 3 ? "THIS IS THE FINAL DIAGNOSTIC TURN. Deliver your synthesis now. Do not ask another question." : "Ask one calibrated question. Output 3 diagnostic CHIPS."}]`;

    const windowedMessages = messages.slice(-10);

    const apiMessages: ChatMessage[] = [
        { role: "system", content: turnAwarePrompt },
        ...windowedMessages,
    ];

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 300,
        messages: apiMessages,
    });

    return NextResponse.json({
        message: completion.choices[0]?.message?.content || "...",
        turnCount: userTurnCount,
        terminated: false,
        mode: "gatekeeper" as AppMode,
    });
}

// --- Universal Off-Topic Guardrail (injected into all gatekeeper-mode prompts) ---
const OFF_TOPIC_GUARDRAIL = `\n\nCRITICAL GUARDRAIL: If the user asks an off-topic question (e.g., math problems, coding help, general trivia, weather, politics, or anything unrelated to operations and business systems), politely decline. Respond with: "lVl is for people who want to turn ideas into constraint-driven systems for personal and business goals. Let's keep the focus there." Then gently guide them back to the active objective. Do not answer off-topic questions under any circumstances.`;

// ============================================================
// SUPPORT MODE (Gatekeeper — existing customer support)
// ============================================================

async function handleSupport(messages: ChatMessage[]) {
    const systemPrompt = `You are the lVl OS Support agent. You help existing customers with technical issues, workflow questions, and feedback.

Rules:
1. Be concise and helpful. 1-3 sentences per response.
2. If the issue requires manual intervention, say: "I'm flagging this for the team. You'll hear back within 24 hours."
3. Always end with a relevant CHIPS suggestion.
4. Do not give operational consulting. Stick to product support.` + OFF_TOPIC_GUARDRAIL;

    const apiMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...messages.slice(-10),
    ];

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 300,
        messages: apiMessages,
    });

    return NextResponse.json({
        message: completion.choices[0]?.message?.content || "...",
        turnCount: messages.filter((m) => m.role === "user").length,
        terminated: false,
        mode: "gatekeeper" as AppMode,
    });
}

// ============================================================
// ENTERPRISE MODE (Gatekeeper — B2B inquiry intake)
// ============================================================

async function handleEnterprise(messages: ChatMessage[]) {
    const systemPrompt = `You are the lVl OS Enterprise intake agent. You qualify B2B leads — multi-location operators, franchise groups, and teams.

Rules:
1. Ask about team size, number of locations, and primary operational pain.
2. Keep responses to 1-2 sentences. Be clinical and direct.
3. After 3 turns, provide a summary and say: "I'll connect you with our team for a custom deployment scope. Expect an email within 24 hours."
4. Always provide 3 diagnostic CHIPS.
5. Do not quote pricing. Do not discuss technical architecture.` + OFF_TOPIC_GUARDRAIL;

    const apiMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...messages.slice(-10),
    ];

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 300,
        messages: apiMessages,
    });

    return NextResponse.json({
        message: completion.choices[0]?.message?.content || "...",
        turnCount: messages.filter((m) => m.role === "user").length,
        terminated: false,
        mode: "gatekeeper" as AppMode,
    });
}

// ============================================================
// FAQ MODE (Post-diagnostic objection handling)
// ============================================================

async function handleFAQ(messages: ChatMessage[]) {
    const userTurnCount = messages.filter((m) => m.role === "user").length;
    const isFirstFAQTurn = userTurnCount <= 1;

    const systemPrompt = `You are the lVl OS FAQ agent. The user just completed a 5-turn diagnostic and chose to ask questions instead of purchasing immediately.

You have the FULL conversation history from the diagnostic. Use it.

${isFirstFAQTurn ? `FIRST RESPONSE ONLY: Provide a concise, tailored overview of how lVl OS directly solves the specific pain points identified in the diagnostic conversation above. Reference their exact words. Then end with: "What else would you like to know before moving forward?"` : `Answer their question directly and concisely. 1-3 sentences. No fluff.`}

=== TESTIMONIAL LORE BANK ===

When the user asks for proof, examples, results, or case studies, select the most relevant testimonial:

BREWERY / RESTAURANT / HOSPITALITY:
"Shaye, President of the Colorado Craft Brewers Guild, used lVl OS to extract undocumented tribal knowledge from her senior staff and convert it into constraint-driven SOPs. Her team stopped losing procedures every time someone quit."

GYM / FITNESS / COACHING:
"Sam used lVl OS to systematize his gym's onboarding, programming, and member retention workflows. Procedures that lived in his head are now documented systems his coaches follow independently."

PERSONAL DEVELOPMENT / SELF-IMPROVEMENT:
"The founder, Omar, lost 155 lbs and taught himself how to code — both using constraint-driven systems. lVl OS was built from the same framework he used to restructure his own life."

=== THE PRIVACY SHIELD (Unmatched Industries) ===

If the user asks about an industry NOT covered above, do NOT invent a name or fake a testimonial. Instead say:
"At lVl, we treat data with a reverence that it is something that will be passed down (Core Value #4). We anonymize specific operational metrics and client identities to protect their competitive advantages."
Then provide a synthesized example: "A Restaurant Operations Manager reduced decision-making time by 30% after extracting their core procedures into documented systems." Or: "A Tech Lead cut onboarding time for new engineers in half by converting tribal knowledge into constraint-driven playbooks."

=== RULES ===

1. You are answering pre-purchase questions. Be honest, direct, and clinical.
2. If asked about pricing, say: "lVl OS is currently in its Founding Cohort phase. The price is $24.99/mo for the first 50 users — that covers raw server and API costs — in exchange for early feedback. The public price will eventually be $129/mo as lVl expands its suite of tools to democratize access to high-end consulting."
3. If asked about competitors, say: "Most tools give you templates. lVl extracts YOUR procedures through conversation and turns them into documented systems."
4. If asked about security, say: "Every customer gets their own isolated server. No shared database. No one else can access your data."
5. If asked about setup time, say: "11 questions to calibrate. First SOP extracted in under 10 minutes."
6. Do not be salesy. Be factual.
7. Always end with 3 relevant CHIPS addressing likely follow-up questions or objections. Do NOT include a 'Start using lVl now' chip — that is handled by the system automatically.` + OFF_TOPIC_GUARDRAIL;

    const apiMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...messages.slice(-20), // Keep more history for FAQ — needs diagnostic context
    ];

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 400,
        messages: apiMessages,
    });

    // Hardcode the persistent closer chip into every FAQ response
    let responseMessage = completion.choices[0]?.message?.content || "...";
    // Append [Start using lVl now] chip if not already present
    if (responseMessage.includes("CHIPS:")) {
        // Insert our chip at the beginning of the existing CHIPS line
        responseMessage = responseMessage.replace(
            /CHIPS:\s*/,
            "CHIPS: [Start using lVl now] | "
        );
    } else {
        // No CHIPS line at all — append one
        responseMessage += "\n\nCHIPS: [Start using lVl now] | [How does it work?] | [What does it cost?]";
    }

    return NextResponse.json({
        message: responseMessage,
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
    const basePrompt = getContextBuilderPrompt();

    // Strip invisible routing commands — these are UI triggers, not user input
    const ROUTING_COMMANDS = new Set(["_init_", "Turn ideas into systems", "Support & Feedback", "Enterprise Inquiry"]);
    const cleanMessages = messages.filter((m) => !(m.role === "user" && ROUTING_COMMANDS.has(m.content)));
    const userTurnCount = cleanMessages.filter((m) => m.role === "user").length;

    // Dynamic turn-awareness: prevent Q1 loop + reinforce CHIPS formatting
    let turnDirective: string;
    if (userTurnCount === 0) {
        turnDirective = "\n\n[SYSTEM: Begin with Step 1 immediately. No preamble. Adapt your phrasing to feel natural. End with dynamic CHIPS.]";
    } else {
        turnDirective = `\n\n[SYSTEM OVERRIDE: The user has answered. This is Step ${userTurnCount + 1} of 11. Evaluate the FULL conversation history. Ask the next thematic question in the sequence — adapt your phrasing to the user's established context. Do NOT repeat previous questions. YOU MUST conclude your response with 2-3 dynamic quick-reply options formatted exactly as: CHIPS: [Option 1] | [Option 2] | [Skip ->]]`;
    }

    const systemPrompt = basePrompt + turnDirective;

    // Full history (cleaned) — no slicing. The 11-question calibration requires complete context.
    const apiMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...cleanMessages,
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

        // --- HARD LOCK: Gatekeeper mode cannot be overridden ---
        // When INSTANCE_MODE is gatekeeper, skip ALL tenant logic:
        // no constraints, no resolveMode, no Extract SOP triggers.
        if (INSTANCE_MODE === "gatekeeper") {
            const chatMode = body.chatMode || "diagnostic";
            console.log(`[lVl] Gatekeeper mode enforced. chatMode: ${chatMode}`);

            switch (chatMode) {
                case "support":
                    return handleSupport(messages);
                case "enterprise":
                    return handleEnterprise(messages);
                case "faq":
                    return handleFAQ(messages);
                case "diagnostic":
                default:
                    return handleGatekeeper(messages);
            }
        }

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
