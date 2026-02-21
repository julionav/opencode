#!/usr/bin/env bun
const PORT = 8100;
const TARGET = "https://api.anthropic.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key, anthropic-version, anthropic-beta",
  "Access-Control-Max-Age": "86400",
};

const log = (method: string, path: string, status: number) => {
  const time = new Date().toISOString();
  console.log(`[${time}] ${method} ${path} -> ${status}`);
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname + url.search;

    if (req.method === "OPTIONS") {
      log(req.method, path, 204);
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const targetUrl = `${TARGET}${path}`;

    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("origin");
    headers.delete("referer");

    const res = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    });

    log(req.method, path, res.status);

    const resHeaders = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      resHeaders.set(k, v);
    }

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
    });
  },
});

console.log(`Proxy running at http://localhost:${PORT} -> ${TARGET}`);
