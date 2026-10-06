import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // WebSerial requires a secure context (localhost qualifies).
    host: "localhost",
  },
});