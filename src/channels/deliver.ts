import type { Log } from "../log.js";
import { idempotencyKeyFor } from "./idempotency.js";
import type { ChannelRegistry } from "./registry.js";
import type { Delivery } from "../domain.js";
import { textFallbackForTemplate } from "../conversation/templates.js";

/**
 * Sends the deliveries for one event. A known template that Actionpackd rejects
 * is sent again as plain text, with a different idempotency key, and a warning.
 * Any other failure throws so the event stays processing and can be resent.
 */
export async function deliverAll(input: {
  channels: ChannelRegistry;
  eventId: string;
  deliveries: Delivery[];
  log: Log;
}): Promise<void> {
  for (const [index, delivery] of input.deliveries.entries()) {
    const adapter = input.channels.require(delivery.channel);
    const idempotencyKey = idempotencyKeyFor(input.eventId, index);
    try {
      await adapter.send({ to: delivery.to, reply: delivery.reply, idempotencyKey });
    } catch (error) {
      const fallback = textFallbackForTemplate(delivery.reply);
      if (!fallback) throw error;
      const templateName = delivery.reply.kind === "template" ? delivery.reply.templateName : "";
      input.log.warn(
        { err: error, eventId: input.eventId, template: templateName },
        "template send failed; sending text instead",
      );
      await adapter.send({
        to: delivery.to,
        reply: fallback,
        idempotencyKey: idempotencyKeyFor(`${input.eventId}:fallback`, index),
      });
    }
  }
}
