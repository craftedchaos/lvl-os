"use client";

export default function Error({ reset }: { reset: () => void }) {
    return (
        <main className="flex items-center justify-center min-h-screen bg-black">
            <p className="text-white text-lg">
                System Error.{" "}
                <button onClick={reset} className="underline text-[#878681]">
                    Refresh.
                </button>
            </p>
        </main>
    );
}
