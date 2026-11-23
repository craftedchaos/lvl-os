import type { NextConfig } from "next";

// Tenant instances keep the OS terminal at "/". The public marketing build
// serves the static IVI page at "/" instead. Both are internal rewrites, so
// the browser URL never changes.
const isTenant = process.env.NEXT_PUBLIC_INSTANCE_MODE === "tenant";

const nextConfig: NextConfig = {
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/",
          destination: isTenant ? "/app" : "/site/index.html",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
