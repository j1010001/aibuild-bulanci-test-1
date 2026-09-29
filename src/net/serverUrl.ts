// Where the game server is (spec §4): the one setting, VITE_SERVER_URL, or by default port
// 8787 on the host that served the page, so devices on the same network can join too.

export function serverUrl(configured: string | undefined, location: { protocol: string; hostname: string }): string {
  if (configured) return configured;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.hostname}:8787`;
}
