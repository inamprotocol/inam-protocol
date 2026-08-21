import { createServer } from "./server.js";
import { config } from "./config.js";

const app = createServer();
app.listen(config.port, () => {
  console.log(`Inam Protocol Registry listening on http://localhost:${config.port}`);
});
