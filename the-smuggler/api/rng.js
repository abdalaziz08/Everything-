// Vercel function: POST /api/rng
import { app } from "../server/instance.js";

export function POST(request) {
  return app.rng(request);
}
