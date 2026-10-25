import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The free invoice reader: native or worker-based packages stay outside the bundle, and the English reading data is shipped with the functions that use it.
  serverExternalPackages: ["tesseract.js", "@napi-rs/canvas", "unpdf"],
  outputFileTracingIncludes: {
    "/**": ["./node_modules/@tesseract.js-data/eng/4.0.0_best_int/**", "./node_modules/tesseract.js/**", "./node_modules/tesseract.js-core/**"],
  },
  experimental: {
    // Invoice uploads go through a server action. Next defaults to 1 MB; Vercel itself rejects bodies over 4.5 MB,
    // and the vault caps files at 4 MB, so this is the most a request can ever be.
    serverActions: { bodySizeLimit: "4.5mb" },
  },
  // The security headers every page should carry.
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};

export default nextConfig;
