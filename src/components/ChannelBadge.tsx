import { channel } from '../channel';

export function ChannelBadge() {
  return channel ? <sup className="channel-badge">{channel.toUpperCase()}</sup> : null;
}
