import { defineConfig, type Plugin } from "vite";
import {
  createReadStream,
  realpathSync,
  statSync
} from "node:fs";
import path from "node:path";

const isolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin"
};
const wasmerSdkDirectory = process.env.CLAWSEMBLY_WASMER_SDK_DIR
  ? realpathSync(process.env.CLAWSEMBLY_WASMER_SDK_DIR)
  : undefined;
const openclawImagePath = process.env.CLAWSEMBLY_OPENCLAW_IMAGE
  ? realpathSync(process.env.CLAWSEMBLY_OPENCLAW_IMAGE)
  : undefined;

const packageImagePlugin: Plugin = {
  name: "clawsembly-package-image",
  configureServer(server) {
    if (!openclawImagePath) return;
    const imageBytes = statSync(openclawImagePath).size;
    server.middlewares.use((request, response, next) => {
      if (request.url?.split("?", 1)[0] !== "/openclaw.clawfs") {
        next();
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Length", String(imageBytes));
      response.setHeader("Content-Type", "application/octet-stream");
      const stream = createReadStream(openclawImagePath);
      stream.once("error", (error) => response.destroy(error));
      stream.pipe(response);
    });
  }
};

export default defineConfig({
  plugins: [packageImagePlugin],
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
      input: [
        "index.html",
        "openclaw-agent-turn-probe.html",
        "openclaw-probe.html",
        "openclaw-gateway-health-probe.html",
        "network-egress-probe.html",
        "package-image-probe.html",
        "package-runtime-probe.html",
        "wasix-probe.html"
      ]
    }
  }
});
