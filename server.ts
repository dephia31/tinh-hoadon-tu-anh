import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // API routes
  app.get("/api/version", (req, res) => {
    res.json({ version: "1.0.1" }); // Increment this manually when redeploying
  });

  app.get("/api/app-config", (req, res) => {
    // Return the API key status and potentially the key itself if in AI Studio
    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    res.json({ 
      hasKey: !!apiKey,
      // In AI Studio Build, it's generally safe to pass the key to the frontend 
      // as it's intended for frontend use anyway.
      apiKey: apiKey || null 
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
