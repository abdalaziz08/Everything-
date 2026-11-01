// Vercel function: POST /api/start
import { app } from "../server/instance.js";

export function POST() {
  return app.start();
}
