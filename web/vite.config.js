import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy /api to the Fastify backend so there's no CORS in local dev.
// Prod: set VITE_API_URL to the deployed API origin (the app calls it directly).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:4000" },
  },
});
