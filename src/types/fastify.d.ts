import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** Exact request bytes, kept so webhook HMAC is not computed over re-serialized JSON. */
    rawBody?: Buffer;
  }

  interface FastifyInstance {
    /** Resolves when background inbound turns started by this process have finished. */
    inboundIdle(): Promise<void>;
  }
}
