// Loads examples/pay-on-proof/.env (gitignored) before any other module reads process.env.
import { existsSync } from "node:fs";
const file = new URL("./.env", import.meta.url);
if (existsSync(file)) process.loadEnvFile(file);
