import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const maxDuration = 300; // 5-minute execution timeout for large SOP generation
import { GATEKEEPER_PROMPT } from "@/lib/prompts/gatekeeper";
import { CONTEXT_BUILDER_PROMPT } from "@/lib/prompts/context-builder";
import { ROOM_2_REFINERY_PROMPT } from "@/lib/prompts/sop-refinery";
import { HORIZONTAL_PROMPT } from "@/lib/prompts/horizontal";
import { SYSTEM_BRAIN_PROMPT } from "@/lib/prompts/system-brain";
import { LVL_CLASS_1_TEMPLATE } from "@/lib/prompts/lvl-class-1-template";
import {
    saveConstraintsDocument,
    loadConstraintsDocument,
    saveSOP,
    loadSOP,
    listSOPs,
    getMostRecentSOP,
} from "@/lib/storage";

const lvlOsResponseFormat = {
    type: "json_schema",
    json_schema: {
        name: "lvl_os_response",
        strict: true,
        schema: {
            type: "object",
            properties: {
                conversational_text: {
                    type: "string",
                    description: "The AI's response to the user."
                },
                routing_chips: {
                    type: "array",
                    items: { type: "string" },
                    description: "2-3 highly contextual routing button labels."
                },
                action_intent: {
                    type: "string",
                    enum: ["chat", "save_document", "compile_final"],
                    description: "Determines if the backend should just chat, or physically patch/save the document."
                },
                edited_sections: {
                    anyOf: [
                        {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    section_header: { type: "string", description: "The exact H2 or H3 heading being modified." },
                                    new_content: { type: "string", description: "The complete replacement text for this specific section." }
                                },
                                required: ["section_header", "new_content"],
                                additionalProperties: false
                            }
                        },
                        { type: "null" }
                    ],
                    description: "ONLY populate this if editing an existing SOP. Leave empty if just chatting."
                },
                extracted_document: {
                    anyOf: [{ type: "string" }, { type: "null" }],
                    description: "If in Room 1 or 2 extracting a FULL new document from scratch. Otherwise null."
                },
                internal_state: {
                    anyOf: [{ type: "string" }, { type: "null" }],
                    description: "If in Room 2, the current extraction phase state tag."
                }
            },
            required: ["conversational_text", "routing_chips", "action_intent", "edited_sections", "extracted_document", "internal_state"],
            additionalProperties: false
        }
    }
} as const;

// --- Utility: Safely patch specific markdown sections ---
function patchSOPDocument(originalMarkdown: string, sectionHeader: string, newContent: string): string {
    const escapedHeader = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^(?:#+)\\s*${escapedHeader}\\s*\\n)([\\s\\S]*?)(?=\\n^\\s*#+|$)`, 'mi');

    if (regex.test(originalMarkdown)) {
        return originalMarkdown.replace(regex, `$1${newContent}\n`);
    } else {
        console.warn(`[lVl] Warning: Section "${sectionHeader}" not found in SOP. Patch failed. appending to bottom.`);
        return originalMarkdown + `\n\n## ${sectionHeader}\n${newContent}\n`;
    }
}

const CONTEXT_MANDATE = `
### FINAL TECHNICAL REQUIREMENT (ROOM 1):
1. SCHEMA: You MUST output strictly in the REQUIRED JSON SCHEMA.
2. TONE (NO THERAPIST): NEVER say "Thank you" or "Noted". If you do, the system will crash.
3. CHIPS (MANDATORY & DYNAMIC): You MUST provide 3 Cunningham's Law guesses specifically tailored to the CURRENT question you are asking. The chips MUST change every single turn.
4. COMPILATION: On Step 11, switch action_intent to "compile_final".
FAILURE TO OUTPUT JSON IS A SYSTEM CRASH.`;

const REFINERY_MANDATE = `
### FINAL TECHNICAL REQUIREMENT:
1. SCHEMA: You MUST output strictly in the REQUIRED JSON SCHEMA.
2. TONE: Clinical, precise, no emotional filler.
3. CHIPS: Output exactly 3 Cunningham's Law chips designed to provoke correction on the current sequence step.
4. COMPILATION: When reaching Step 17 (or when signaled by user), switch action_intent to "compile_final" and use the exact Markdown Blueprint provided.
FAILURE TO OUTPUT JSON IS A SYSTEM CRASH.`;

const WORKSPACE_MANDATE = `
CRITICAL JSON MANDATE:
1. You MUST return ONLY valid JSON. No markdown wrappers.
2. ALL output MUST strictly adhere to the expected schema.
3. EXTRACTED_DOCUMENT: Keep null unless executing compile_final (Step 17).
4. CHIPS: You MUST output EXACTLY 3 chips in the routing_chips array. 
   - IF IN STATE A (No SOP loaded): They MUST be formatted EXACTLY as "[Extract SOP: Task Name]". 
   - IF IN STATE B (SOP loaded): They MUST be short, dynamic action steps or questions to refine the document. DO NOT use the Extract SOP syntax here.
`;

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
    brainDump?: ChatMessage[]; // Triage context passed when Extract SOP chip fires
}

// --- Utility: Detect "Extract SOP:" trigger in the latest user message ---
function detectExtractSOPTrigger(messages: ChatMessage[]): string | null {
    if (messages.length === 0) return null;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return null;
    const match = lastUserMsg.content.match(/^\[?Extract SOP:\s*(.*?)\]?$/i);
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

    const rawText = completion.choices[0]?.message?.content || "...";

    // --- Chip Extraction: strip "CHIPS: [X] | [Y] | [Z]" from raw text ---
    let cleanMessage = rawText;
    let chips: string[] = [];

    const chipMatch = rawText.match(/CHIPS:\s*(.+)$/im);
    if (chipMatch) {
        // Remove the entire CHIPS line from the display text
        cleanMessage = rawText.replace(/\n*CHIPS:\s*.+$/im, "").trim();
        // Extract individual chip values: split on | and strip brackets/whitespace
        chips = chipMatch[1]
            .split("|")
            .map((c) => c.trim().replace(/^\[|\]$/g, ""))
            .filter((c) => c.length > 0);
    }

    return NextResponse.json({
        message: cleanMessage,
        chips,
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

    const rawText = completion.choices[0]?.message?.content || "...";
    let cleanMessage = rawText;
    let chips: string[] = [];
    const chipMatch = rawText.match(/CHIPS:\s*(.+)$/im);
    if (chipMatch) {
        cleanMessage = rawText.replace(/\n*CHIPS:\s*.+$/im, "").trim();
        chips = chipMatch[1].split("|").map((c) => c.trim().replace(/^\[|\]$/g, "")).filter((c) => c.length > 0);
    }

    return NextResponse.json({
        message: cleanMessage,
        chips,
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

    const rawText = completion.choices[0]?.message?.content || "...";
    let cleanMessage = rawText;
    let chips: string[] = [];
    const chipMatch = rawText.match(/CHIPS:\s*(.+)$/im);
    if (chipMatch) {
        cleanMessage = rawText.replace(/\n*CHIPS:\s*.+$/im, "").trim();
        chips = chipMatch[1].split("|").map((c) => c.trim().replace(/^\[|\]$/g, "")).filter((c) => c.length > 0);
    }

    return NextResponse.json({
        message: cleanMessage,
        chips,
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

    const rawText = completion.choices[0]?.message?.content || "...";
    let cleanMessage = rawText;
    let chips: string[] = [];
    const chipMatch = rawText.match(/CHIPS:\s*(.+)$/im);
    if (chipMatch) {
        cleanMessage = rawText.replace(/\n*CHIPS:\s*.+$/im, "").trim();
        chips = chipMatch[1].split("|").map((c) => c.trim().replace(/^\[|\]$/g, "")).filter((c) => c.length > 0);
    }

    // Hardcode the persistent closer chip into every FAQ response
    if (!chips.includes("Start using lVl now")) {
        chips.unshift("Start using lVl now");
    }
    // Fallback if AI produced no chips at all
    if (chips.length <= 1) {
        chips = ["Start using lVl now", "How does it work?", "What does it cost?"];
    }

    return NextResponse.json({
        message: cleanMessage,
        chips,
        turnCount: userTurnCount,
        terminated: false,
        mode: "gatekeeper" as AppMode,
    });
}

// ============================================================
// CONTEXT BUILDER (no constraints.md yet)
// ============================================================

async function handleContextBuilder(messages: ChatMessage[]) {
    const basePrompt = CONTEXT_BUILDER_PROMPT;

    // Strip invisible routing commands — these are UI triggers, not user input
    const ROUTING_COMMANDS = new Set(["_init_", "Turn ideas into systems", "Support & Feedback", "Enterprise Inquiry"]);
    const cleanMessages = messages.filter((m) => !(m.role === "user" && ROUTING_COMMANDS.has(m.content)));
    const userTurnCount = cleanMessages.filter((m) => m.role === "user").length;

    // Dynamic turn-awareness: prevent Q1 loop + reinforce CHIPS formatting
    let turnDirective: string;
    if (userTurnCount === 0) {
        turnDirective = "\n\n[SYSTEM: Begin with Step 1 immediately. No preamble. Adapt your phrasing to feel natural.]";
    } else {
        turnDirective = `\n\n[SYSTEM OVERRIDE: The user has answered. This is turn ${userTurnCount + 1} of the calibration sequence. Evaluate the FULL conversation history. Ask the next thematic question in the sequence — adapt your phrasing to the user's established context. Do NOT repeat previous questions. If this is a Voss Checkpoint turn (after Step 4 or Step 8), provide ONLY the synthesis — do NOT ask the next question.]`;
    }

    const systemPrompt = basePrompt + turnDirective + "\n\n" + CONTEXT_MANDATE;

    // Full history (cleaned) — no slicing. The 11-question calibration requires complete context.
    const apiMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...cleanMessages,
    ];

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 2500,
        messages: apiMessages,
        response_format: lvlOsResponseFormat,
    });

    const rawContent = completion.choices[0]?.message?.content || "{}";

    // Sanitize: strip markdown code fences if the model wraps its output in ```json ... ```
    const sanitized = rawContent
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();

    let parsedResponse;
    try {
        parsedResponse = JSON.parse(sanitized);
    } catch (error) {
        console.error("🚨 JSON PARSE FAILED. RAW AI OUTPUT WAS:");
        console.error(rawContent);
        return NextResponse.json({ error: "AI returned invalid JSON." }, { status: 500 });
    }

    const { conversational_text = "...", routing_chips = [], action_intent = "chat", extracted_document = null } = parsedResponse;

    const isCompiling = action_intent === "compile_final" && extracted_document;

    if (isCompiling) {
        saveConstraintsDocument(extracted_document);
        console.log("[lVl] Constraints Document saved.");
    }

    // --- Phase 2 → Phase 3 transition ---
    let finalMessage = conversational_text;
    let fallbackChips = routing_chips;

    if (isCompiling) {
        fallbackChips = ["Initiate Daily Brain Dump", "Extract a Specific Task"];
    }

    return NextResponse.json({
        message: finalMessage,
        chips: fallbackChips,
        turnCount: messages.filter((m) => m.role === "user").length,
        terminated: false,
        mode: "context-builder" as AppMode,
        constraintsSaved: !!isCompiling,
        ...(isCompiling ? { nextMode: "horizontal" as AppMode } : {}),
    });
}

// ============================================================
// SOP REFINERY (constraints.md exists, extraction triggered)
// ============================================================

async function handleSOPRefinery(
    messages: ChatMessage[],
    constraints: string,
    taskNameContext?: string,
    brainDump?: ChatMessage[]
) {
    const TEMPLATE_INSTRUCTION = `
### FINAL OUTPUT BLUEPRINT (DO NOT USE UNTIL STEP 17)
The following is the lVl Class 1 Template. You must IGNORE this structure entirely while asking the 17 questions. 
ONLY when you reach Step 17 and switch your action_intent to "compile_final", you will map the collected answers into this exact Markdown structure inside the "extracted_document" field:

${LVL_CLASS_1_TEMPLATE}
`;

    let systemPrompt = SYSTEM_BRAIN_PROMPT + "\n\n" + ROOM_2_REFINERY_PROMPT + "\n\n" + TEMPLATE_INSTRUCTION + "\n\n" + REFINERY_MANDATE;
    systemPrompt = systemPrompt.replaceAll("{CONSTRAINTS}", constraints);

    // --- "Extract SOP:" trigger: inject task name context and skip S1 ---
    let apiMessages: ChatMessage[];

    if (taskNameContext) {
        // Build background context block from Triage brain dump if available
        const brainDumpBlock: ChatMessage | null =
            brainDump && brainDump.length > 0
                ? {
                    role: "system",
                    content: `--- BACKGROUND CONTEXT (Triage Brain Dump) ---\nThe user provided the following context during their Triage session BEFORE selecting this process. Use this to ground your 17 questions in their actual scenario. Do NOT re-ask anything they have already described:\n\n${brainDump.map((m) => `[${m.role.toUpperCase()}]: ${m.content}`).join("\n\n")}\n--- END BACKGROUND CONTEXT ---`,
                }
                : null;

        const contextHint: ChatMessage = {
            role: "system",
            content: `The user has selected to extract the SOP for "${taskNameContext}". Acknowledge this precisely. SKIP Step 1 (Which process are we mapping?), and begin the sequence immediately by asking Step 2.`,
        };
        apiMessages = [
            { role: "system", content: systemPrompt },
            ...(brainDumpBlock ? [brainDumpBlock] : []),
            contextHint,
            ...messages,
        ];
        console.log(`[lVl] SOP Refinery triggered with context: ${taskNameContext}${
            brainDump?.length ? ` + ${brainDump.length} brain dump messages` : ""
        }`);
    } else {
        // No sliding window for SOP Refinery — full message array passed
        apiMessages = [
            { role: "system", content: systemPrompt },
            ...messages,
        ];
    }

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 16384,
        messages: apiMessages,
        response_format: lvlOsResponseFormat,
    });

    const rawSOPContent = completion.choices[0]?.message?.content || "{}";
    const sanitizedSOP = rawSOPContent
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
    let parsedResponse;
    try {
        parsedResponse = JSON.parse(sanitizedSOP);
    } catch (parseError) {
        console.error(`[lVl] Fatal JSON Parse Error in Refinery. Raw output length: ${rawSOPContent.length}`, parseError);
        return NextResponse.json({
            message: "I encountered a formatting error while compiling the final document structure. Please click the chip below to safely retry the compilation.",
            chips: ["Retry Compilation"],
            turnCount: messages.filter((m) => m.role === "user").length,
            terminated: false,
            mode: "sop-refinery"
        });
    }
    const {
        conversational_text = "...",
        routing_chips = [],
        action_intent = "chat",
        extracted_document = null,
        internal_state = null
    } = parsedResponse;

    let savedSOPName: string | null = null;
    let sopName: string = taskNameContext || "untitled";

    if (action_intent === "compile_final" && extracted_document) {
        const nameMatch = extracted_document.match(/^#\s+(.+)$/m);
        if (nameMatch) {
            sopName = nameMatch[1].trim();
        }

        const safeName = sopName.replace(/[^a-zA-Z0-9_-]/g, "_");
        saveSOP(sopName, extracted_document);
        savedSOPName = safeName;
        console.log(`[lVl] SOP saved: ${sopName}`);
    }

    let finalMessage = conversational_text;
    let finalChips = routing_chips;

    // Server-side chip enforcement on compilation
    if (savedSOPName) {
        finalChips = ["Enter Workspace to Refine This", "Extract Another SOP"];
    }

    return NextResponse.json({
        message: finalMessage,
        chips: finalChips,
        turnCount: messages.filter((m) => m.role === "user").length,
        terminated: false,
        mode: "sop-refinery" as AppMode,
        sopSaved: !!extracted_document,
        activeSOP: savedSOPName,
        ...(extracted_document ? { document_content: extracted_document } : {}),
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
    let prompt = SYSTEM_BRAIN_PROMPT + "\n\n" + HORIZONTAL_PROMPT + "\n\n" + WORKSPACE_MANDATE;
    prompt = prompt.replaceAll("{CONSTRAINTS}", constraints);

    // Inject active SOP context
    if (activeSOP) {
        const sopContent = loadSOP(activeSOP);
        if (sopContent) {
            const sopBlock = `--- ACTIVE SOP: ${activeSOP} ---\n${sopContent}\n--- END SOP ---`;
            prompt = prompt.replaceAll("{ACTIVE_SOP_BLOCK}", sopBlock);
        } else {
            prompt = prompt.replaceAll("{ACTIVE_SOP_BLOCK}", "");
        }
    } else {
        prompt = prompt.replaceAll("{ACTIVE_SOP_BLOCK}", "");
    }

    // Inject SOP inventory for context grounding
    const existingSOPs = listSOPs();
    if (existingSOPs.length > 0) {
        const inventory = `--- SOP INVENTORY (${existingSOPs.length} files) ---\n${existingSOPs.map((f) => `- ${f}`).join("\n")}\n--- END INVENTORY ---`;
        prompt = prompt.replaceAll("{SOP_INVENTORY}", inventory);
    } else {
        prompt = prompt.replaceAll("{SOP_INVENTORY}", "No SOPs on file yet.");
    }

    // Sliding window: last 10 messages (token defense for daily use)
    const windowedMessages = messages.slice(-10);

    const apiMessages: ChatMessage[] = [
        { role: "system", content: prompt },
        ...windowedMessages,
    ];

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 2500,
        messages: apiMessages,
        response_format: lvlOsResponseFormat,
    });

    const parsedResponse = JSON.parse(completion.choices[0]?.message?.content || "{}");
    const {
        conversational_text = "...",
        routing_chips = [],
        action_intent = "chat",
        edited_sections = [],
        extracted_document = null
    } = parsedResponse;

    let savedSOPName: string | null = null;
    let sopName: string = "untitled";
    let updatedDocumentContent: string | null = null;

    if (action_intent === "save_document" && activeSOP && edited_sections && edited_sections.length > 0) {
        let currentSOP = loadSOP(activeSOP) || "";
        for (const edit of edited_sections) {
            currentSOP = patchSOPDocument(currentSOP, edit.section_header, edit.new_content);
        }
        saveSOP(activeSOP, currentSOP);
        savedSOPName = activeSOP;
        updatedDocumentContent = currentSOP;
        console.log(`[lVl] SOP patched safely: ${activeSOP}`);
    } else if (action_intent === "compile_final" && extracted_document) {
        const nameMatch = extracted_document.match(/^#\s*SOP:\s*(.+)$/m);
        if (nameMatch) {
            sopName = nameMatch[1].trim();
        }

        const safeName = sopName.replace(/[^a-zA-Z0-9_-]/g, "_");
        saveSOP(sopName, extracted_document);
        savedSOPName = safeName;
        console.log(`[lVl] Refined SOP saved: ${sopName}`);
    }

    let finalMessage = conversational_text;
    let finalChips = routing_chips;

    // Server-side chip enforcement
    if (savedSOPName) {
        finalChips = ["Keep refining", "Lock it", "Extract another SOP"];
    }

    const cleanInventory = existingSOPs.map((f) => f.replace(/\.md$/, ""));

    return NextResponse.json({
        message: finalMessage,
        chips: finalChips,
        turnCount: messages.filter((m) => m.role === "user").length,
        terminated: false,
        mode: "horizontal" as AppMode,
        activeSOP: savedSOPName || activeSOP,
        sopSaved: !!extracted_document,
        inventory: cleanInventory,
        ...(updatedDocumentContent ? { document_content: updatedDocumentContent } : {}),
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
            const brainDump = (body.brainDump || []) as ChatMessage[];
            return handleSOPRefinery(
                [{ role: "user", content: `Extract SOP: ${extractTrigger}` }],
                constraints!,
                extractTrigger,
                brainDump
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
