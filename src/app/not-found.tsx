import Link from "next/link";

export default function NotFound() {
    return (
        <main className="flex items-center justify-center min-h-screen bg-black">
            <p className="text-white text-lg">
                404.{" "}
                <Link href="/" className="underline text-[#878681]">
                    Return.
                </Link>
            </p>
        </main>
    );
}
