import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev server only serves its scripts to localhost by default. Allow opening it
  // from this machine's LAN address (e.g. to test on a phone). Dev-only; no effect on Vercel.
  allowedDevOrigins: ["192.168.1.2"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
