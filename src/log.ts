/** Subset of pino/Fastify's logger used outside the request. */
export interface Log {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export const silentLog: Log = {
  info() {},
  warn() {},
  error() {},
};
