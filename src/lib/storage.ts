import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// --- The Vercel Guard ---
// Vercel uses a read-only filesystem. If we are in gatekeeper mode,
// all storage operations safely no-op to prevent serverless crashes.
const IS_GATEKEEPER = process.env.INSTANCE_MODE === "gatekeeper";
const DATA_DIR = process.env.DATA_DIR || "./data";
const CONSTRAINTS_PATH = join(DATA_DIR, "constraints.md");
const SOPS_DIR = join(DATA_DIR, "sops");

function ensureDir(dir: string): void {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

export function saveConstraintsDocument(content: string): void {
    if (IS_GATEKEEPER) return;
    ensureDir(DATA_DIR);
    writeFileSync(CONSTRAINTS_PATH, content, "utf-8");
}

export function loadConstraintsDocument(): string | null {
    if (IS_GATEKEEPER) return null;
    if (!existsSync(CONSTRAINTS_PATH)) return null;
    return readFileSync(CONSTRAINTS_PATH, "utf-8");
}

export function saveSOP(name: string, content: string): void {
    if (IS_GATEKEEPER) return;
    ensureDir(SOPS_DIR);
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    writeFileSync(join(SOPS_DIR, `${safeName}.md`), content, "utf-8");
}

export function listSOPs(): string[] {
    if (IS_GATEKEEPER) return [];
    if (!existsSync(SOPS_DIR)) return [];
    return readdirSync(SOPS_DIR).filter((f) => f.endsWith(".md"));
}

export function loadSOP(name: string): string | null {
    if (IS_GATEKEEPER) return null;
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = join(SOPS_DIR, safeName.endsWith(".md") ? safeName : `${safeName}.md`);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
}

export function getMostRecentSOP(): string | null {
    if (IS_GATEKEEPER) return null;
    if (!existsSync(SOPS_DIR)) return null;
    const files = readdirSync(SOPS_DIR).filter((f) => f.endsWith(".md"));
    if (files.length === 0) return null;
    // Return the most recently modified file
    const sorted = files
        .map((f) => ({ name: f, mtime: statSync(join(SOPS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    return sorted[0].name;
}
