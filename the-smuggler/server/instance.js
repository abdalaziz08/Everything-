// The app as deployed: secret from the environment, encrypted trophy from server/trophy.js.
import { createApp } from "./app.js";
import { TROPHY } from "./trophy.js";

export const app = createApp({ secret: process.env.SMUGGLER_SECRET, trophy: TROPHY });
