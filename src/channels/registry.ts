import type { ChannelId } from "../domain.js";
import type { ChannelAdapter } from "./adapter.js";

export class ChannelRegistry {
  private readonly byChannel = new Map<ChannelId, ChannelAdapter>();

  constructor(adapters: ChannelAdapter[]) {
    for (const adapter of adapters) {
      this.byChannel.set(adapter.channel, adapter);
    }
  }

  require(channel: ChannelId): ChannelAdapter {
    const adapter = this.byChannel.get(channel);
    if (!adapter) {
      throw new Error(`No adapter registered for channel ${channel}`);
    }
    return adapter;
  }
}
