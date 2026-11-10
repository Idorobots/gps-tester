import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the build works under any GitHub Pages subpath.
  base: "./",
  server: {
    // WebSerial requires a secure context (localhost qualifies).
    host: "localhost",
  },
});