import { defineConfig } from "vite";
import { realpathSync } from "node:fs";
import path from "node:path";

const isolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin"
};
const wasmerSdkDirectory = process.env.CLAWSEMBLY_WASMER_SDK_DIR
  ? realpathSync(process.env.CLAWSEMBLY_WASMER_SDK_DIR)
  : undefined;

export default defineConfig({
  resolve: {
    alias: wasmerSdkDirectory
      ? {
          "@wasmer/sdk": path.join(wasmerSdkDirectory, "index.mjs")
        }
      : {}
  },
  server: {
    headers: isolationHeaders,
    fs: {
      allow: wasmerSdkDirectory
        ? [process.cwd(), wasmerSdkDirectory]
        : [process.cwd()]
    }
  },
  preview: {
    headers: isolationHeaders
  },
  worker: {
    format: "es"
  },
  build: {
    target: "es2023",
    rollupOptions: {
      input: ["index.html", "openclaw-probe.html", "wasix-probe.html"]
    }
  }
});
