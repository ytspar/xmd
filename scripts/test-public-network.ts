/** DNS rebinding, redirect and address validation regressions; no external requests. */
import assert from "node:assert/strict";
import { mock } from "node:test";
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { httpGet } from "../src/links.js";
import { isPublicAddress, publicHttpUrl } from "../src/public-network.js";

for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "198.18.0.1", "192.0.2.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "fe80::1", "fc00::1", "ff02::1", "2001:db8::1", "2002:7f00:1::", "3fff::1"]) {
  assert.equal(isPublicAddress(address), false, address);
}
for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(isPublicAddress(address), true, address);
for (const url of ["http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://[::ffff:127.0.0.1]/", "http://localhost./", "https://a.localhost/", "http://service.internal/", "https://user:password@example.com/", "ftp://example.com/", "http://example.com:8080/"]) {
  assert.throws(() => publicHttpUrl(url), url);
}
let lookups: string[] = [];
let requests: string[] = [];
const resolver = mock.method(dns, "lookup", async (host: string) => {
  lookups.push(host);
  if (host === "private.example") return [{ address: "127.0.0.1", family: 4 }];
  if (host === "mixed.example") return [{ address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }];
  if (host === "empty.example") return [];
  if (host === "slow.example") return new Promise(() => {});
  if (host === "failed.example") throw new Error("DNS unavailable");
  return [{ address: "93.184.216.34", family: 4 }];
});
const fakeFetch = mock.method(globalThis, "fetch", async (input: string) => {
  requests.push(input);
  if (input.endsWith("/relative")) return new Response(null, { status: 302, headers: { location: "/ok" } });
  if (input.includes("redirect")) return new Response(null, { status: 302, headers: { location: "http://private.example/secret" } });
  if (input.includes("loop")) return new Response(null, { status: 302, headers: { location: "/loop" } });
  return new Response("public content");
});
try {
  for (const host of ["private", "mixed", "empty", "failed", "slow"]) {
    assert.equal(await httpGet(`http://${host}.example/`, undefined, { retries: 0, timeoutMs: 40 }), null);
  }
  assert.deepEqual(requests, [], "Rejected or timed-out DNS must never reach transport");
  assert.equal(await httpGet("https://public.example/redirect", undefined, { retries: 0 }), null);
  assert.deepEqual(requests, ["https://public.example/redirect"], "Validate redirect DNS before contacting its destination");
  requests = [];
  assert.equal(await httpGet("http://public.example/loop", undefined, { retries: 0 }), null);
  assert.equal(requests.length, 6, "Redirect traversal remains bounded");
  requests = [];
  assert.equal((await httpGet("http://public.example/ok", undefined, { retries: 0 }))?.buf.toString(), "public content");
  requests = []; lookups = [];
  const redirected = await httpGet("http://public.example/relative", undefined, { retries: 0 });
  assert.equal(redirected?.finalUrl, "http://public.example/ok");
  assert.deepEqual(lookups, ["public.example", "public.example"], "Even same-host redirects require a new validated resolution");
  fakeFetch.mock.restore();

  // Exercise the real fetch + Undici transport against a local HTTP fixture. Only
  // the test socket is rerouted; production must supply the pinned lookup to it.
  const received: string[] = [];
  let stalledClosed = false;
  const server = http.createServer((req, res) => {
    received.push(req.headers.host ?? "");
    if (req.url === "/stall") {
      res.on("close", () => { stalledClosed = true; });
      res.writeHead(200); res.flushHeaders(); return;
    }
    res.setHeader("content-encoding", "gzip");
    res.end(gzipSync(Buffer.from("decoded public content")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const originalConnect = net.connect;
  let pinnedCalls = 0;
  const socketMock = mock.method(net, "connect", (options: net.TcpNetConnectOpts) => {
    assert.equal(options.host, "rebind.example");
    assert.ok(options.lookup, "The actual connection must receive a pinned DNS lookup");
    options.lookup!("rebind.example", { all: true }, (error, answers) => {
      assert.equal(error, null);
      assert.deepEqual(answers, [{ address: "93.184.216.34", family: 4 }]);
      pinnedCalls++;
    });
    options.lookup!("rebind.example", {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, "93.184.216.34"); assert.equal(family, 4);
      pinnedCalls++;
    });
    return originalConnect({ host: "127.0.0.1", port });
  });
  lookups = [];
  resolver.mock.mockImplementation(async (host: string) => {
    lookups.push(host);
    return [{ address: lookups.length === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
  });
  try {
    const response = await httpGet("http://rebind.example/", undefined, { retries: 0, timeoutMs: 2_000 });
    assert.equal(response?.buf.toString(), "decoded public content");
    assert.deepEqual(lookups, ["rebind.example"], "The connection must not resolve DNS again");
    assert.deepEqual(received, ["rebind.example"], "Keep the URL's Host header");
    assert.equal(pinnedCalls, 2);
    resolver.mock.mockImplementation(async () => [{ address: "93.184.216.34", family: 4 }]);
    assert.equal(await httpGet("http://rebind.example/stall", undefined, { retries: 0, timeoutMs: 200 }), null);
    for (let i = 0; i < 20 && !stalledClosed; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(stalledClosed, true, "Body deadline destroys the connection and releases the response");
  } finally {
    socketMock.mock.restore();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  // Inspect TLS connection options without disabling certificate validation.
  resolver.mock.mockImplementation(async () => [{ address: "93.184.216.34", family: 4 }]);
  let tlsCalls = 0;
  const tlsMock = mock.method(tls, "connect", (options: tls.ConnectionOptions) => {
    tlsCalls++;
    assert.equal(options.servername, "secure.example");
    assert.notEqual(options.rejectUnauthorized, false);
    assert.ok(options.lookup);
    throw new Error("Stop before external TLS connection");
  });
  try { assert.equal(await httpGet("https://secure.example/", undefined, { retries: 0 }), null); assert.equal(tlsCalls, 1); }
  finally { tlsMock.mock.restore(); }
  console.log("Public DNS, mixed answers, timeout, redirects, pinned sockets, Host/SNI and decompression passed");
} finally { mock.restoreAll(); }
