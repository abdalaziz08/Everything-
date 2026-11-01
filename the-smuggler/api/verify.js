// Vercel function: POST /api/verify
import { app } from "../server/instance.js";

export function POST(request) {
  return app.verify(request);
}
