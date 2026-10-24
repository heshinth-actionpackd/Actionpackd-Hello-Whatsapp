import type { FastifyServerOptions } from "fastify";
import type { AppConfig } from "./config.js";

export function loggerOptions(config: AppConfig): FastifyServerOptions["logger"] {
  const base = {
    level: config.LOG_LEVEL,
    redact: {
      paths: ["req.headers.authorization", 'req.headers["x-actionpackd-signature-v2"]'],
      remove: true,
    },
  };

  // pino-pretty is a devDependency. The production image does not include it.
  if (config.NODE_ENV === "development") {
    return {
      ...base,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
    };
  }

  return base;
}
