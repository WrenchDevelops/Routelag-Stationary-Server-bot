import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp(config);

await app.listen({ host: config.host, port: config.port });
app.log.info(`PathGen server listening on ${config.host}:${config.port}`);
