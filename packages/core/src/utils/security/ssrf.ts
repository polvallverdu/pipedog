// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/security/ssrf.py

/**
 * Guards against server-side request forgery via client-supplied URLs.
 *
 * Porting notes: Python's `ipaddress` module has no JavaScript counterpart, so
 * this module carries the small part of it it needs (`IPNetwork`,
 * `ipAddressIsGlobal`). Host resolution goes through a pluggable
 * `HostResolver`; the default one uses `node:dns` through
 * `process.getBuiltinModule` where the runtime provides it (Bun, Node, Deno),
 * and otherwise only resolves IP literals, so a hostname that cannot be
 * resolved is `BLOCKED`.
 */

import { abortable, rethrowIfCancelled } from "@pipecat-ts/asyncio";

/** Who can safely reach a URL's host. */
export const UrlReachability = {
  /** Publicly routable — safe to hand to a third party to fetch itself. */
  PUBLIC: "public",
  /**
   * Within a trusted private network — safe for this server to fetch
   * directly, but not to hand off to a third party that can't reach it.
   */
  ALLOWED: "allowed",
  /** Nobody should fetch it. */
  BLOCKED: "blocked",
} as const;
export type UrlReachability = (typeof UrlReachability)[keyof typeof UrlReachability];

//
// IP addresses (the subset of Python's `ipaddress` this module needs)
//

/** A parsed IP address: its version and its value as a bigint. */
export interface IPAddress {
  version: 4 | 6;
  value: bigint;
}

function parseIPv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    // Python rejects leading zeros (ambiguous octal).
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIPv6(text: string): bigint | null {
  // Drop a scope id ("fe80::1%eth0").
  const address = text.split("%")[0] ?? "";
  if (!address.includes(":")) return null;
  let head = address;
  let tailV4: bigint | null = null;
  const lastColon = address.lastIndexOf(":");
  const last = address.slice(lastColon + 1);
  if (last.includes(".")) {
    tailV4 = parseIPv4(last);
    if (tailV4 === null) return null;
    head = `${address.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const groups: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(Number.parseInt(g, 16));
    }
    return groups;
  };
  const left = parseGroups(halves[0] ?? "");
  const right = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (left === null || right === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(g);
  if (tailV4 !== null) value = (value & ~0xffffffffn) | tailV4;
  return value;
}

/**
 * Parse an IPv4 or IPv6 address (Python's `ipaddress.ip_address`).
 *
 * @throws Error If `text` is not a valid address (upstream: ValueError).
 */
export function ipAddress(text: string): IPAddress {
  const v4 = parseIPv4(text);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseIPv6(text);
  if (v6 !== null) return { version: 6, value: v6 };
  throw new Error(`'${text}' does not appear to be an IPv4 or IPv6 address`);
}

/** An IPv4 or IPv6 network in CIDR form (Python's `IPv4Network | IPv6Network`). */
export class IPNetwork {
  readonly version: 4 | 6;
  readonly networkAddress: bigint;
  readonly prefixlen: number;
  readonly #mask: bigint;

  /**
   * @param cidr A network such as `"10.0.0.0/8"` or `"fd00::/8"`. A bare
   *   address is a single-host network. Host bits must be zero, as Python's
   *   strict default requires.
   * @throws Error If `cidr` is not a valid network (upstream: ValueError).
   */
  constructor(cidr: string) {
    const [addressText, prefixText] = cidr.trim().split("/");
    const address = ipAddress(addressText ?? "");
    const bits = address.version === 4 ? 32 : 128;
    const prefixlen = prefixText === undefined ? bits : Number(prefixText);
    if (!Number.isInteger(prefixlen) || prefixlen < 0 || prefixlen > bits) {
      throw new Error(`'${cidr}' does not appear to be an IPv4 or IPv6 network`);
    }
    const all = (1n << BigInt(bits)) - 1n;
    const mask = (all << BigInt(bits - prefixlen)) & all;
    if ((address.value & mask) !== address.value) {
      throw new Error(`${cidr} has host bits set`);
    }
    this.version = address.version;
    this.networkAddress = address.value;
    this.prefixlen = prefixlen;
    this.#mask = mask;
  }

  /** Whether `address` lies in this network (Python's `ip in network`). */
  contains(address: IPAddress): boolean {
    return address.version === this.version && (address.value & this.#mask) === this.networkAddress;
  }

  toString(): string {
    return `${formatAddress({ version: this.version, value: this.networkAddress })}/${this.prefixlen}`;
  }
}

function formatAddress(address: IPAddress): string {
  if (address.version === 4) {
    const v = address.value;
    return [24n, 16n, 8n, 0n].map((s) => ((v >> s) & 0xffn).toString()).join(".");
  }
  const groups: string[] = [];
  for (let s = 112n; s >= 0n; s -= 16n) groups.push(((address.value >> s) & 0xffffn).toString(16));
  return groups.join(":");
}

// The IANA special-purpose registries, as Python's `ipaddress` lists them.
const IPV4_PRIVATE = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/29",
  "192.0.0.170/31",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "240.0.0.0/4",
  "255.255.255.255/32",
].map((n) => new IPNetwork(n));
const IPV4_PRIVATE_EXCEPTIONS = ["192.0.0.9/32", "192.0.0.10/32"].map((n) => new IPNetwork(n));
const IPV4_SHARED_ADDRESS_SPACE = new IPNetwork("100.64.0.0/10");

const IPV6_PRIVATE = [
  "::1/128",
  "::/128",
  "::ffff:0:0/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "fc00::/7",
  "fe80::/10",
].map((n) => new IPNetwork(n));
const IPV6_PRIVATE_EXCEPTIONS = [
  "2001:1::1/128",
  "2001:1::2/128",
  "2001:3::/32",
  "2001:4:112::/48",
  "2001:20::/28",
  "2001:30::/28",
].map((n) => new IPNetwork(n));
const IPV4_MAPPED = new IPNetwork("::ffff:0:0/96");

/** Python's `ip_address(...).is_global`. */
export function ipAddressIsGlobal(address: IPAddress): boolean {
  if (address.version === 4) {
    const isPrivate =
      IPV4_PRIVATE.some((n) => n.contains(address)) &&
      !IPV4_PRIVATE_EXCEPTIONS.some((n) => n.contains(address));
    return !IPV4_SHARED_ADDRESS_SPACE.contains(address) && !isPrivate;
  }
  // An IPv4-mapped address is judged by the IPv4 address it carries.
  if (IPV4_MAPPED.contains(address)) {
    return ipAddressIsGlobal({ version: 4, value: address.value & 0xffffffffn });
  }
  const isPrivate =
    IPV6_PRIVATE.some((n) => n.contains(address)) &&
    !IPV6_PRIVATE_EXCEPTIONS.some((n) => n.contains(address));
  return !isPrivate;
}

//
// Host resolution
//

/** Resolve a hostname to its IP addresses (as `getaddrinfo` does). Throw if it fails. */
export type HostResolver = (hostname: string) => Promise<string[]>;

interface DnsPromises {
  lookup(hostname: string, options: { all: true }): Promise<{ address: string }[]>;
}

function nodeDns(): DnsPromises | null {
  const proc = (
    globalThis as { process?: { getBuiltinModule?: (id: string) => { promises?: DnsPromises } } }
  ).process;
  try {
    return proc?.getBuiltinModule?.("node:dns")?.promises ?? null;
  } catch (e) {
    rethrowIfCancelled(e);
    return null;
  }
}

/** The default resolver: IP literals as-is, hostnames through `node:dns` if available. */
export const defaultHostResolver: HostResolver = async (hostname) => {
  try {
    ipAddress(hostname);
    return [hostname];
  } catch (e) {
    rethrowIfCancelled(e);
  }
  const dns = nodeDns();
  if (!dns) {
    throw new Error(`no DNS resolver available to resolve '${hostname}'`);
  }
  const infos = await abortable(dns.lookup(hostname, { all: true }));
  return infos.map((info) => info.address);
};

let hostResolver: HostResolver = defaultHostResolver;

/** Install the resolver `classifyUrlReachability` uses. Pass `null` for the default. */
export function setHostResolver(resolver: HostResolver | null): void {
  hostResolver = resolver ?? defaultHostResolver;
}

function getenv(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    name
  ];
}

/**
 * Return trusted networks from the `PIPECAT_ALLOWED_FILE_URL_NETWORKS` env var.
 *
 * Parses a comma-separated list of CIDR ranges (e.g.
 * `10.0.0.0/8,192.168.0.0/16`). Returns an empty list (trust only the
 * public internet) when the variable is unset or empty.
 */
export function defaultAllowedFileUrlNetworks(): string[] {
  const val = getenv("PIPECAT_ALLOWED_FILE_URL_NETWORKS") ?? "";
  return val
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n);
}

function urlHostname(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    rethrowIfCancelled(e);
    return null;
  }
  let hostname = parsed.hostname;
  // `URL` keeps the brackets around IPv6 literals; `urlsplit` does not.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  return hostname ? hostname.toLowerCase() : null;
}

/**
 * Classify who can safely reach `url`'s host: the public internet, this server, or no one.
 *
 * Resolution happens once, up front; it doesn't defend against a target
 * that resolves differently between this check and the actual connection
 * (DNS rebinding).
 *
 * @param url The URL to classify.
 * @param allowedNetworks Private networks this server is trusted to reach
 *   directly (e.g. where a deployment's own file servers live), beyond the
 *   public internet.
 * @returns `PUBLIC` if every resolved address is publicly routable — safe to
 *   hand to a third party (e.g. an LLM provider) to fetch itself.
 *   `ALLOWED` if not publicly routable, but every address falls within
 *   `allowedNetworks` — safe for this server to fetch directly, but not to
 *   hand off to a third party that can't reach it.
 *   `BLOCKED` otherwise: loopback, link-local (including the cloud metadata
 *   range `169.254.0.0/16`), private (RFC 1918), or unique-local (IPv6 ULA)
 *   addresses outside `allowedNetworks`, or a host that fails to resolve.
 */
export async function classifyUrlReachability(
  url: string,
  allowedNetworks: readonly IPNetwork[] = [],
): Promise<UrlReachability> {
  const hostname = urlHostname(url);
  if (!hostname) {
    return UrlReachability.BLOCKED;
  }
  let addresses: string[];
  try {
    addresses = await hostResolver(hostname);
  } catch (e) {
    rethrowIfCancelled(e);
    return UrlReachability.BLOCKED;
  }
  if (addresses.length === 0) {
    return UrlReachability.BLOCKED;
  }

  const ips = addresses.map((a) => ipAddress(a));
  if (ips.every((ip) => ipAddressIsGlobal(ip))) {
    return UrlReachability.PUBLIC;
  }
  if (
    ips.every(
      (ip) => ipAddressIsGlobal(ip) || allowedNetworks.some((network) => network.contains(ip)),
    )
  ) {
    return UrlReachability.ALLOWED;
  }
  return UrlReachability.BLOCKED;
}
