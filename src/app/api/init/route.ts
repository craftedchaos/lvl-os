import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const CONSTRAINTS_FILE = path.join(DATA_DIR, "constraints.md");
const SOP_DIR = path.join(DATA_DIR, "sops");

export async function GET() {
    try {
        // Evaluate constraint existence (Phase 1 to Phase 3 condition)
        const hasConstraints = fs.existsSync(CONSTRAINTS_FILE);
        
        // Fetch inventory
        let inventory: string[] = [];
        if (fs.existsSync(SOP_DIR)) {
            const files = fs.readdirSync(SOP_DIR);
            inventory = files
                .filter((file) => file.endsWith(".md"))
                .map((file) => file.replace(/\.md$/, ""));
        }

        return NextResponse.json({
            hasConstraints,
            inventory,
        });
    } catch (error) {
        console.error("[lVl Init] Failed to initialize state:", error);
        return NextResponse.json({ error: "System error" }, { status: 500 });
    }
}
