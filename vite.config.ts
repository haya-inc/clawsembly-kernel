import { defineConfig } from "vite";

const isolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin"
};

export default defineConfig({
  server: {
    headers: isolationHeaders
  },
  preview: {
    headers: isolationHeaders
  },
  worker: {
    format: "es"
  },
  build: {
    target: "es2023"
  }
});
