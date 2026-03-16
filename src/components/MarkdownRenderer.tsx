"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";

interface MarkdownRendererProps {
    content: string;
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
    const [copied, setCopied] = useState(false);

    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Fallback: do nothing
        }
    }

    return (
        <div className="relative group">
            {/* Copy button — appears on hover, top-right */}
            <button
                onClick={handleCopy}
                className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150 text-[#878681] hover:text-white text-xs px-2 py-1 cursor-pointer"
                aria-label="Copy to clipboard"
            >
                {copied ? "✓" : "⎘"}
            </button>

            <div className="prose prose-invert max-w-none text-sm">
                <ReactMarkdown
                    components={{
                        h1: ({ children }) => <h1 className="text-white text-lg font-bold mt-4 mb-2">{children}</h1>,
                        h2: ({ children }) => <h2 className="text-white text-base font-semibold mt-3 mb-1">{children}</h2>,
                        h3: ({ children }) => <h3 className="text-[#878681] text-sm font-medium mt-2 mb-1">{children}</h3>,
                        p: ({ children }) => <p className="text-[#878681] text-sm mb-2">{children}</p>,
                        li: ({ children }) => <li className="text-[#878681] text-sm ml-4">{children}</li>,
                        strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
                        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-white underline hover:text-[#878681] transition-colors">{children}</a>,
                        hr: () => <hr className="border-[#1a1a1a] my-4" />,
                    }}
                >
                    {content}
                </ReactMarkdown>
            </div>
        </div>
    );
}
