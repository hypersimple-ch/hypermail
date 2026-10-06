import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

/** Canonicalize socket and forwarded literals; ports, zones and hostnames are not IP identities. */
function normalize(value: string): string | null {
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6 || value.includes('%')) return null;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const highHex = mapped[1], lowHex = mapped[2];
  if (highHex === undefined || lowHex === undefined) return null;
  const high = parseInt(highHex, 16), low = parseInt(lowHex, 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
}

/** Compile once at composition, with no implicit trust of private or loopback addresses. */
export function createClientIpResolver(cidrs: readonly string[] = []): (request: IncomingMessage) => string {
  const trusted = new BlockList();
  for (const cidr of cidrs) {
    const [literal, prefix, extra] = cidr.split('/');
    const family = isIP(literal ?? '');
    const bits = Number(prefix);
    if (literal === undefined || prefix === undefined || extra !== undefined || !family || !/^\d+$/.test(prefix) || bits < 0 || bits > (family === 4 ? 32 : 128)) throw new TypeError('Invalid trusted proxy CIDR');
    trusted.addSubnet(literal, bits, family === 4 ? 'ipv4' : 'ipv6');
  }
  return (request) => {
    const socket = normalize(request.socket.remoteAddress ?? '') ?? 'unknown';
    if (socket === 'unknown' || !trusted.check(socket, isIP(socket) === 4 ? 'ipv4' : 'ipv6')) return socket;
    const header = request.headers['x-forwarded-for'];
    if (typeof header !== 'string' || header.length > 8_192) return socket;
    const hops = header.split(',').map(value => normalize(value.trim()));
    if (!hops.length || hops.length > 100 || hops.some(ip => ip === null)) return socket;
    for (let index = hops.length - 1; index >= 0; index--) {
      const ip = hops[index];
      if (ip === undefined || ip === null) return socket;
      if (!trusted.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6')) return ip;
    }
    return hops[0] ?? socket;
  };
}
