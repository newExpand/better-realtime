import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const devPort = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return value;
};
const demoPort = devPort("REALTIME_DEMO_PORT", 43_171);
const serverPort = devPort("REALTIME_SERVER_PORT", 43_170);
const serverHttpUrl = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: demoPort,
    strictPort: true,
    proxy: {
      "/api": serverHttpUrl,
      "/health": serverHttpUrl,
      "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true }
    }
  }
});
