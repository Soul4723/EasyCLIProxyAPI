// Main builds leave VITE_CHANNEL unset or set to main, so they keep the unmodified branding.
const value = import.meta.env.VITE_CHANNEL;
export const channel: 'dev' | 'beta' | null = value === 'dev' || value === 'beta' ? value : null;

export const defaultCorePort = channel === 'dev' ? 8319 : channel === 'beta' ? 8318 : 8317;

if (channel && typeof document !== 'undefined') document.documentElement.dataset.channel = channel;
