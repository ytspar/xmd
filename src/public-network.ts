/** Public-only DNS resolution and connection pinning for untrusted source URLs. */
import dns from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  // Excludes mapped IPv4, translation/tunnel ranges, local, multicast and reserved space.
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export class UnsafePublicUrlError extends Error {}

export function publicHttpUrl(input: string): URL {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new UnsafePublicUrlError("Source URLs require public HTTP(S), standard ports and no credentials.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || /\.(?:localhost|local|internal)$/.test(host) || (isIP(host) && !isPublicAddress(host))) {
    throw new UnsafePublicUrlError("Source URL is not public.");
  }
  return url;
}

/** One dispatcher per hop: no proxy, shared socket pool, or second DNS lookup. */
export async function publicDispatcher(url: URL, signal: AbortSignal): Promise<Agent> {
  signal.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let onAbort: () => void = () => {};
  const answers = await Promise.race([
    isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : dns.lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]).finally(() => signal.removeEventListener("abort", onAbort));
  signal.throwIfAborted();
  if (!answers.length || answers.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) {
    throw new UnsafePublicUrlError("Source DNS includes a non-public or invalid address.");
  }
  const selected = answers[0];
  const lookup: LookupFunction = (_hostname, options, callback) => {
    // Undici retains the original URL hostname for Host, SNI and TLS verification.
    if (options.all) callback(null, [selected]);
    else callback(null, selected.address, selected.family);
  };
  return new Agent({ connect: { lookup }, connections: 1 });
}
