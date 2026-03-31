import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const SOP_DIR = path.join(process.cwd(), "data", "sops");

export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const name = url.searchParams.get("name");

    if (!name) {
        return NextResponse.json({ error: "Document name required" }, { status: 400 });
    }

    try {
        const filePath = path.join(SOP_DIR, `${name}.md`);
        if (!fs.existsSync(filePath)) {
            return NextResponse.json({ error: "Document not found" }, { status: 404 });
        }
        const content = fs.readFileSync(filePath, "utf-8");
        return NextResponse.json({ name, content });
    } catch (error) {
        console.error(`[lVl Document Store] GET failed for ${name}:`, error);
        return NextResponse.json({ error: "System error" }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    const url = new URL(req.url);
    const name = url.searchParams.get("name");

    if (!name) {
        return NextResponse.json({ error: "Document name required" }, { status: 400 });
    }

    try {
        const filePath = path.join(SOP_DIR, `${name}.md`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        
        // Return updated inventory
        let inventory: string[] = [];
        if (fs.existsSync(SOP_DIR)) {
            const files = fs.readdirSync(SOP_DIR);
            inventory = files
                .filter((file) => file.endsWith(".md"))
                .map((file) => file.replace(/\.md$/, ""));
        }
        
        return NextResponse.json({ success: true, inventory });
    } catch (error) {
        console.error(`[lVl Document Store] DELETE failed for ${name}:`, error);
        return NextResponse.json({ error: "System error" }, { status: 500 });
    }
}
