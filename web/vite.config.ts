import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// `just dev` runs the server on MAPCRO_PORT; Vite proxies the API, the socket and the packs to it.
const target = `http://127.0.0.1:${process.env.MAPCRO_PORT ?? "8094"}`;

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": target,
      "/packs": target,
      "/healthz": target,
      "/ws": { target, ws: true },
    },
  },
  build: { target: "es2022" },
});
