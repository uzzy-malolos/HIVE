import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

export interface OAuthNetworkPolicy {
  allowLoopbackOAuthHttp?: boolean;
  allowPrivateOAuthHosts?: boolean;
}
const reservedV4 = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) reservedV4.addSubnet(network, prefix, "ipv4");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
const reservedV6 = new BlockList();
for (const [network, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) reservedV6.addSubnet(network, prefix, "ipv6");

/** Node's IP parser/BlockList handles compressed and mapped forms; no textual IP regex. */
export function publicOAuthAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !reservedV4.check(address, "ipv4") : family === 6 ? globalV6.check(address, "ipv6") && !reservedV6.check(address, "ipv6") : false;
}
function literalLoopback(url: URL): boolean { return url.hostname === "127.0.0.1" || url.hostname === "[::1]"; }
export function validateOAuthUrl(value: string, policy: OAuthNetworkPolicy): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error("OAuth endpoint must be an absolute URL"); }
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(policy.allowLoopbackOAuthHttp && url.protocol === "http:" && literalLoopback(url)))) throw new Error("OAuth endpoints require HTTPS without credentials or fragments");
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const developmentLoopback = policy.allowLoopbackOAuthHttp && url.protocol === "http:" && literalLoopback(url);
  if (isIP(host) && !publicOAuthAddress(host) && !developmentLoopback && !policy.allowPrivateOAuthHosts) throw new Error("OAuth endpoint cannot target a private, loopback or reserved address");
  return url;
}

type Address = { address: string; family: number };
export type OAuthLookup = (hostname: string) => Promise<Address[]>;
const systemLookup: OAuthLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** Resolve once, validate the complete answer set, and retain the address for the socket. */
export async function resolveOAuthAddress(value: string, policy: OAuthNetworkPolicy, signal?: AbortSignal, resolve: OAuthLookup = systemLookup): Promise<Address> {
  const url = validateOAuthUrl(value, policy); const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (signal?.aborted) throw new DOMException("OAuth request cancelled", "AbortError");
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { abort = () => reject(new DOMException("OAuth request cancelled", "AbortError")); signal?.addEventListener("abort", abort, { once: true }); });
  try {
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([resolve(host), aborted]);
    if (!addresses.length || addresses.length > 64 || addresses.some((entry) => !isIP(entry.address) || entry.family !== isIP(entry.address))) throw new Error("OAuth hostname returned invalid DNS addresses");
    const developmentLoopback = policy.allowLoopbackOAuthHttp && url.protocol === "http:" && literalLoopback(url);
    if (!policy.allowPrivateOAuthHosts && !developmentLoopback && addresses.some((entry) => !publicOAuthAddress(entry.address))) throw new Error("OAuth hostname cannot resolve to private, loopback or reserved addresses");
    return addresses[0];
  } finally { signal?.removeEventListener("abort", abort); }
}

export interface OAuthNetworkRequest extends OAuthNetworkPolicy {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  headersOnly?: boolean;
  /** Default OAuth metadata/token limit is 64 KiB; bounded catalog callers may opt in to a larger response. */
  maxResponseBytes?: number;
}
export interface OAuthNetworkResponse { status: number; headers: Headers; bytes: Buffer }

/** Direct socket requests pin checked DNS while preserving TLS hostname verification.
 * No proxy, ambient credentials, connection-pool reuse, or redirect following.
 */
export async function oauthNetworkRequest(value: string, options: OAuthNetworkRequest, resolveAddress?: OAuthLookup): Promise<OAuthNetworkResponse> {
  const maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1024 * 1024) throw new Error("Network response limit must be an integer from 1 byte to 1 MiB");
  const url = validateOAuthUrl(value, options); const address = await resolveOAuthAddress(value, options, options.signal, resolveAddress);
  if (options.signal?.aborted) throw new DOMException("OAuth request cancelled", "AbortError");
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    // Connect to the checked numeric address directly. Host and TLS servername
    // remain the original authority, including normal certificate verification.
    const pinned: https.RequestOptions = { method: options.method ?? "GET", hostname: address.address, headers: { ...options.headers, host: url.host }, signal: options.signal, agent: false, ...(url.protocol === "https:" && !isIP(host) ? { servername: host } : {}) };
    const request = transport.request(url, pinned, (response) => {
      const status = response.statusCode ?? 0; const headers = new Headers();
      for (const [key, raw] of Object.entries(response.headers)) if (raw !== undefined) headers.set(key, Array.isArray(raw) ? raw.join(", ") : raw);
      if (options.headersOnly || status < 200 || status >= 300) { response.destroy(); resolve({ status, headers, bytes: Buffer.alloc(0) }); return; }
      const chunks: Buffer[] = []; let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxResponseBytes) {
          const failure = new Error(`OAuth endpoint response exceeds ${Math.ceil(maxResponseBytes / 1024)} KiB`);
          reject(failure); response.destroy(failure);
        } else chunks.push(chunk);
      });
      response.once("error", reject); response.once("aborted", () => reject(new Error("OAuth response was interrupted"))); response.once("end", () => resolve({ status, headers, bytes: Buffer.concat(chunks) }));
    });
    request.once("error", reject);
    request.end(options.body);
  });
}
