import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";

import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

// --- Config ---
const PORT = Number(process.env.PORT ?? 3000);
const GBFS_ROOT = process.env.GBFS_ROOT ?? "https://gbfs.baywheels.com/gbfs/2.3/gbfs.json";
const TTL_MS = Number(process.env.GBFS_TTL_MS ?? 30_000);

// Optional security/cors
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ENABLE_DNS_REBIND = process.env.ENABLE_DNS_REBIND === "true";

// --- Tiny fetch cache with ETag ---
type CacheEntry = { data: any; etag?: string; at: number };
const cache = new Map<string, CacheEntry>();

async function fetchJsonWithCache(url: string): Promise<any> {
  const now = Date.now();
  const cached = cache.get(url);
  const headers: Record<string, string> = {};
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (cached && now - cached.at < TTL_MS) return cached.data;

  const resp = await fetch(url, { headers });
  if (resp.status === 304 && cached) {
    cached.at = now;
    return cached.data;
  }
  if (!resp.ok) throw new Error(`Fetch failed ${resp.status} for ${url}`);
  const etag = resp.headers.get("etag") ?? undefined;
  const data = await resp.json();
  cache.set(url, { data, etag, at: now });
  return data;
}

let feedMapMemo: { at: number; map: Record<string, string> | null } = {
  at: 0,
  map: null,
};

async function loadFeedMap(): Promise<Record<string, string>> {
  const now = Date.now();
  if (feedMapMemo.map && now - feedMapMemo.at < TTL_MS) return feedMapMemo.map;
  const root = await fetchJsonWithCache(GBFS_ROOT);
  const dataByLocale: Record<string, any> = root?.data ?? {};
  const locales = Object.keys(dataByLocale);
  if (!locales.length) throw new Error("No GBFS locales found");
  const primaryLocale = "en" in dataByLocale ? "en" : (locales[0] as string);
  const primary = dataByLocale[primaryLocale];
  const feeds: Array<{ name: string; url: string }> = Array.isArray(primary?.feeds)
    ? primary.feeds
    : [];
  const map = Object.fromEntries(feeds.map((f: { name: string; url: string }) => [f.name, f.url]));
  feedMapMemo = { at: now, map };
  return map;
}

async function getFeed(name: string): Promise<any> {
  const map = await loadFeedMap();
  const url = map[name];
  if (!url) throw new Error(`GBFS feed not found: ${name}`);
  return fetchJsonWithCache(url);
}

function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180,
    lat2 = (b.lat * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// --- MCP server setup ---
const server = new McpServer({ name: "baywheels-mcp", version: "0.1.0" });

// Resource: raw GBFS JSON via template gbfs://{name}
server.registerResource(
  "gbfs-feed",
  new ResourceTemplate("gbfs://{name}", {
    list: async () => {
      const names = Object.keys(await loadFeedMap());
      return {
        resources: names.map((n) => ({
          name: n,
          uri: `gbfs://${n}`,
          title: `GBFS ${n}`,
          description: `Bay Wheels GBFS feed: ${n}`,
          mimeType: "application/json",
        })),
      };
    },
  }),
  {
    title: "Bay Wheels GBFS feed",
    description: "Raw GBFS JSON (station_information, station_status, etc.)",
    mimeType: "application/json",
  },
  async (uri, { name }) => {
    const json = await getFeed(String(name));
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(json),
        },
      ],
    };
  },
);

// Tool: list stations (id, name, lat, lon, capacity)
server.registerTool(
  "list_stations",
  {
    title: "List Bay Wheels stations",
    description: "Lists stations with basic metadata",
    inputSchema: {},
  },
  async () => {
    const info = await getFeed("station_information");
    const stations = info.data.stations.map((s: any) => ({
      station_id: s.station_id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      capacity: s.capacity ?? null,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(stations, null, 2) }],
    };
  },
);

// Tool: bikes at a station
server.registerTool(
  "bikes_at_station",
  {
    title: "Get bikes/docks at a station",
    description: "Live availability for a given station_id",
    inputSchema: { station_id: z.string() },
  },
  async ({ station_id }) => {
    const [info, status] = await Promise.all([
      getFeed("station_information"),
      getFeed("station_status"),
    ]);
    const sInfo = info.data.stations.find((s: any) => s.station_id === station_id);
    const sStat = status.data.stations.find((s: any) => s.station_id === station_id);
    if (!sInfo || !sStat) {
      return {
        content: [{ type: "text", text: `Station ${station_id} not found` }],
        isError: true,
      };
    }
    const out = {
      station_id,
      name: sInfo.name,
      lat: sInfo.lat,
      lon: sInfo.lon,
      capacity: sInfo.capacity ?? null,
      status: {
        last_reported: sStat.last_reported,
        num_bikes_available: sStat.num_bikes_available,
        num_docks_available: sStat.num_docks_available,
        is_installed: sStat.is_installed,
        is_renting: sStat.is_renting,
        is_returning: sStat.is_returning,
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

// Optional: nearest stations
server.registerTool(
  "nearest_station",
  {
    title: "Find nearest stations",
    description: "Closest stations with live availability",
    inputSchema: {
      lat: z.number(),
      lon: z.number(),
      limit: z.number().int().positive().max(20).default(5),
    },
  },
  async ({ lat, lon, limit }) => {
    const [info, status] = await Promise.all([
      getFeed("station_information"),
      getFeed("station_status"),
    ]);
    const statusById = new Map<string, any>(
      status.data.stations.map((s: any) => [s.station_id, s]),
    );
    const enriched = info.data.stations
      .map((s: any) => {
        const st = statusById.get(s.station_id) ?? {};
        const distance_m = Math.round(haversineMeters({ lat, lon }, { lat: s.lat, lon: s.lon }));
        return {
          station_id: s.station_id,
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          capacity: s.capacity ?? null,
          distance_m,
          num_bikes_available: st.num_bikes_available ?? null,
          num_docks_available: st.num_docks_available ?? null,
          is_installed: st.is_installed ?? null,
          is_renting: st.is_renting ?? null,
          is_returning: st.is_returning ?? null,
        };
      })
      .sort((a: any, b: any) => a.distance_m - b.distance_m)
      .slice(0, limit);
    return {
      content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }],
    };
  },
);

// --- Transports and HTTP wiring (Node http for SDK compatibility) ---
const streamableTransports: Record<string, StreamableHTTPServerTransport> = {};
const sseTransports: Record<string, SSEServerTransport> = {};

function setCors(res: import("node:http").ServerResponse) {
  if (ALLOWED_ORIGINS.length) {
    // Reflect first allowed origin (or implement strict matching per request)
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS[0] as string);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    // Preflight CORS
    if (req.method === "OPTIONS") {
      setCors(res);
      res.writeHead(204).end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      setCors(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Modern Streamable HTTP at /mcp
    if (url.pathname === "/mcp") {
      // Streamable transport requires session management handling
      if (req.method === "POST") {
        // Read body
        const bodyStr = await new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          req.on("data", (c) => chunks.push(Buffer.from(c)));
          req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          req.on("error", reject);
        });
        let body: unknown = undefined;
        try {
          body = bodyStr ? JSON.parse(bodyStr) : undefined;
        } catch {
          // leave undefined; transport will error appropriately
        }

        const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
        let transport: StreamableHTTPServerTransport | undefined;

        if (sessionId && streamableTransports[sessionId]) {
          transport = streamableTransports[sessionId];
        } else if (!sessionId && body && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              streamableTransports[sid] = transport!;
            },
            onsessionclosed: (sid) => {
              delete streamableTransports[sid];
            },
            enableDnsRebindingProtection: ENABLE_DNS_REBIND,
            allowedHosts: ALLOWED_HOSTS.length ? ALLOWED_HOSTS : undefined,
            allowedOrigins: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : undefined,
          });
          // Connect newly created transport
          await server.connect(transport);
        } else {
          setCors(res);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Bad Request: No valid session ID provided" },
              id: null,
            }),
          );
          return;
        }

        // Let transport handle
        setCors(res);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        const transport = sessionId ? streamableTransports[sessionId] : undefined;
        if (!sessionId || !transport) {
          setCors(res);
          res.writeHead(400).end("Invalid or missing session ID");
          return;
        }
        setCors(res);
        await transport.handleRequest(req, res);
        return;
      }

      // Unsupported
      setCors(res);
      res.writeHead(405).end();
      return;
    }

    // Legacy SSE endpoints
    if (req.method === "GET" && url.pathname === "/sse") {
      // Create SSE transport and connect
      const transport = new SSEServerTransport("/messages", res, {
        enableDnsRebindingProtection: ENABLE_DNS_REBIND,
        allowedHosts: ALLOWED_HOSTS.length ? ALLOWED_HOSTS : undefined,
        allowedOrigins: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : undefined,
      });
      sseTransports[transport.sessionId] = transport;
      res.on("close", () => {
        delete sseTransports[transport.sessionId];
      });
      await server.connect(transport);
      // Note: SSEServerTransport.start() is called by server.connect()
      return;
    }

    if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const transport = sessionId ? sseTransports[sessionId] : undefined;
      if (!transport) {
        res.writeHead(400).end("No transport for sessionId");
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    // Default 404
    res.writeHead(404).end("Not Found");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      res.writeHead(500).end(msg);
    } catch {}
  }
});

httpServer.listen(PORT, () => {
  console.log(
    `Bay Wheels MCP listening on :${PORT}\n` +
      `Streamable HTTP endpoint: POST/GET/DELETE /mcp\n` +
      `SSE endpoint:                GET            /sse\n` +
      `Legacy message endpoint:     POST           /messages?sessionId=<id>\n` +
      `Health:                      GET            /healthz\n` +
      `GBFS root: ${GBFS_ROOT}`,
  );
});
