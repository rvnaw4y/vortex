import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "url";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));
const adminStatePath = fileURLToPath(
    new URL("../data/admin-state.json", import.meta.url)
);
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const envLocalPath = fileURLToPath(new URL("../.env.local", import.meta.url));
const activeClientWindowMs = 45_000;

const liveClients = new Map();
const clientStreams = new Map();

let adminStateLoaded = false;
let adminStateCache = {
    announcement: null,
    blockedClients: {},
};

function loadEnvFromFile(path) {
    let content = "";
    try {
        content = readFileSync(path, "utf8");
    } catch {
        return;
    }

    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;

        const separatorIndex = line.indexOf("=");
        if (separatorIndex <= 0) continue;

        const key = line.slice(0, separatorIndex).trim();
        if (!key || process.env[key] !== undefined) continue;

        let value = line.slice(separatorIndex + 1).trim();
        const isQuoted =
            (value.startsWith("\"") && value.endsWith("\"")) ||
            (value.startsWith("'") && value.endsWith("'"));
        if (isQuoted) {
            value = value.slice(1, -1);
        }

        process.env[key] = value;
    }
}

loadEnvFromFile(envPath);
loadEnvFromFile(envLocalPath);

const adminKey = process.env.VORTEX_ADMIN_KEY || process.env.ADMIN_KEY || "";

// Wisp Configuration
logging.set_level(logging.NONE);
Object.assign(wisp.options, {
    allow_udp_streams: false,
    hostname_blacklist: [/example\.com/],
    dns_servers: ["1.1.1.1", "1.0.0.1"],
});

// SSL Configuration for all Haven.best subdomains
const sslOptions = {
    cert: readFileSync("/etc/letsencrypt/live/haven.best/fullchain.pem"),
    key: readFileSync("/etc/letsencrypt/live/haven.best/privkey.pem"),
};

const fastify = Fastify({
    serverFactory: (handler) => {
        return createHttpsServer(sslOptions, handler).on(
            "upgrade",
            (req, socket, head) => {
                if (req.url.endsWith("/wisp/")) {
                    wisp.routeRequest(req, socket, head);
                } else {
                    socket.end();
                }
            }
        );
    },
});

function safeString(value, maxLength = 2000) {
    if (typeof value !== "string") return "";
    return value.trim().slice(0, maxLength);
}

function safeHttpUrl(value) {
    if (!value) return "";
    try {
        const url = new URL(value);
        if (url.protocol === "http:" || url.protocol === "https:") {
            return url.toString();
        }
        return "";
    } catch {
        return "";
    }
}

function normalizeAnnouncement(payload) {
    if (!payload || typeof payload !== "object") return null;

    const title = safeString(payload.title, 120);
    const message = safeString(payload.message, 4000);
    if (!title || !message) return null;

    const linkText = safeString(payload.linkText, 40);
    const linkUrl = safeHttpUrl(safeString(payload.linkUrl, 1200));

    return {
        id: Date.now().toString(),
        title,
        message,
        linkText: linkUrl ? linkText || "Open Link" : "",
        linkUrl,
        createdAt: new Date().toISOString(),
    };
}

function normalizeClientId(value) {
    const id = safeString(value, 80);
    if (!id) return "";
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return "";
    return id;
}

function normalizeBlockReason(value) {
    const reason = safeString(value, 250);
    return reason || "No reason provided by admin.";
}

function normalizeState(raw) {
    const state = raw && typeof raw === "object" ? raw : {};
    const announcement =
        state.announcement && typeof state.announcement === "object"
            ? state.announcement
            : null;
    const blockedClients =
        state.blockedClients && typeof state.blockedClients === "object"
            ? state.blockedClients
            : {};

    return { announcement, blockedClients };
}

async function readAdminStateFromDisk() {
    try {
        const raw = await readFile(adminStatePath, "utf8");
        return normalizeState(JSON.parse(raw));
    } catch (err) {
        if (err && typeof err === "object" && err.code === "ENOENT") {
            return normalizeState(null);
        }
        console.error("Failed to read admin state", err);
        return normalizeState(null);
    }
}

async function writeAdminStateToDisk(state) {
    await mkdir(dirname(adminStatePath), { recursive: true });
    await writeFile(adminStatePath, JSON.stringify(state, null, 2), "utf8");
}

async function getAdminState() {
    if (!adminStateLoaded) {
        adminStateCache = await readAdminStateFromDisk();
        adminStateLoaded = true;
    }
    return adminStateCache;
}

async function saveAdminState(state) {
    adminStateCache = normalizeState(state);
    adminStateLoaded = true;
    await writeAdminStateToDisk(adminStateCache);
    return adminStateCache;
}

async function updateAdminState(mutateFn) {
    const current = await getAdminState();
    const draft = {
        announcement: current.announcement,
        blockedClients: { ...current.blockedClients },
    };
    const next = mutateFn(draft) || draft;
    return saveAdminState(next);
}

function extractKey(req) {
    const headerKey = req.headers["x-admin-key"];
    if (typeof headerKey === "string" && headerKey) return headerKey;
    if (Array.isArray(headerKey) && typeof headerKey[0] === "string") {
        return headerKey[0];
    }

    const body = req.body;
    if (body && typeof body === "object" && typeof body.key === "string") {
        return body.key;
    }

    return "";
}

function isAuthorized(req) {
    if (!adminKey) return false;
    return extractKey(req) === adminKey;
}

function requireAdmin(req, reply) {
    if (!adminKey) {
        reply.code(503).send({
            error: "Admin key is not configured on the server.",
        });
        return false;
    }
    if (!isAuthorized(req)) {
        reply.code(401).send({ error: "Invalid admin key." });
        return false;
    }
    return true;
}

function getBlockedRecord(state, clientId) {
    const blocked = state.blockedClients?.[clientId];
    if (!blocked || typeof blocked !== "object") return null;

    return {
        reason: normalizeBlockReason(blocked.reason),
        blockedAt: safeString(blocked.blockedAt, 64) || "",
    };
}

function getClientIp(req) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded) {
        const first = forwarded.split(",")[0];
        return safeString(first, 120) || "unknown";
    }
    if (Array.isArray(forwarded) && forwarded[0]) {
        const first = String(forwarded[0]).split(",")[0];
        return safeString(first, 120) || "unknown";
    }
    return req.ip || req.socket?.remoteAddress || "unknown";
}

function upsertLiveClient(req, clientId, page = "") {
    const now = Date.now();
    const existing = liveClients.get(clientId);
    const base = existing || {
        id: clientId,
        firstSeenMs: now,
    };

    const updated = {
        ...base,
        lastSeenMs: now,
        page: safeString(page, 120),
        userAgent: safeString(req.headers["user-agent"], 240),
        ip: getClientIp(req),
    };
    liveClients.set(clientId, updated);
    return updated;
}

function getActiveClients(state) {
    const cutoff = Date.now() - activeClientWindowMs;
    const active = [];

    for (const [clientId, client] of liveClients.entries()) {
        if (!client || client.lastSeenMs < cutoff) {
            liveClients.delete(clientId);
            continue;
        }

        const blocked = getBlockedRecord(state, clientId);
        active.push({
            id: clientId,
            ip: client.ip || "unknown",
            userAgent: client.userAgent || "",
            page: client.page || "",
            firstSeenAt: new Date(client.firstSeenMs).toISOString(),
            lastSeenAt: new Date(client.lastSeenMs).toISOString(),
            blocked: Boolean(blocked),
            blockReason: blocked?.reason || "",
        });
    }

    active.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    return active;
}

function addClientStream(clientId, sendEvent) {
    let set = clientStreams.get(clientId);
    if (!set) {
        set = new Set();
        clientStreams.set(clientId, set);
    }
    set.add(sendEvent);

    return () => {
        const current = clientStreams.get(clientId);
        if (!current) return;
        current.delete(sendEvent);
        if (current.size === 0) {
            clientStreams.delete(clientId);
        }
    };
}

function notifyClient(clientId, eventName, payload) {
    const listeners = clientStreams.get(clientId);
    if (!listeners) return;

    for (const sendEvent of listeners) {
        try {
            sendEvent(eventName, payload);
        } catch {}
    }
}

// Static file serving
fastify.register(fastifyStatic, { root: publicPath, decorateReply: true });
fastify.register(fastifyStatic, {
    root: scramjetPath,
    prefix: "/scram/",
    decorateReply: false,
});
fastify.register(fastifyStatic, {
    root: libcurlPath,
    prefix: "/libcurl/",
    decorateReply: false,
});
fastify.register(fastifyStatic, {
    root: baremuxPath,
    prefix: "/baremux/",
    decorateReply: false,
});

fastify.get("/api/announcements/latest", async () => {
    const state = await getAdminState();
    return { announcement: state.announcement };
});

fastify.post("/api/announcements/latest", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const announcement = normalizeAnnouncement(req.body);
    if (!announcement) {
        return reply
            .code(400)
            .send({ error: "Title and message are required." });
    }

    await updateAdminState((draft) => {
        draft.announcement = announcement;
        return draft;
    });
    return { ok: true, announcement };
});

fastify.delete("/api/announcements/latest", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    await updateAdminState((draft) => {
        draft.announcement = null;
        return draft;
    });
    return { ok: true };
});

fastify.post("/api/client/heartbeat", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const clientId = normalizeClientId(body.clientId);
    if (!clientId) {
        return reply.code(400).send({ error: "Invalid client id." });
    }

    upsertLiveClient(req, clientId, body.page);

    const state = await getAdminState();
    const blocked = getBlockedRecord(state, clientId);
    return {
        ok: true,
        blocked: Boolean(blocked),
        reason: blocked?.reason || "",
    };
});

fastify.get("/api/client/stream", async (req, reply) => {
    const query = req.query && typeof req.query === "object" ? req.query : {};
    const clientId = normalizeClientId(query.clientId);
    if (!clientId) {
        return reply.code(400).send({ error: "Invalid client id." });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
    });

    const sendEvent = (eventName, payload) => {
        reply.raw.write(`event: ${eventName}\n`);
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const removeStream = addClientStream(clientId, sendEvent);
    const keepAlive = setInterval(() => {
        reply.raw.write(": ping\n\n");
    }, 25_000);

    const state = await getAdminState();
    const blocked = getBlockedRecord(state, clientId);
    sendEvent("status", {
        blocked: Boolean(blocked),
        reason: blocked?.reason || "",
    });

    reply.raw.on("close", () => {
        clearInterval(keepAlive);
        removeStream();
    });
});

fastify.get("/api/admin/clients", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const state = await getAdminState();
    const clients = getActiveClients(state);
    return {
        connectedCount: clients.length,
        clients,
    };
});

fastify.post("/api/admin/clients/block", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const clientId = normalizeClientId(body.clientId);
    if (!clientId) {
        return reply.code(400).send({ error: "Invalid client id." });
    }

    const reason = normalizeBlockReason(body.reason);
    await updateAdminState((draft) => {
        draft.blockedClients[clientId] = {
            reason,
            blockedAt: new Date().toISOString(),
        };
        return draft;
    });

    notifyClient(clientId, "blocked", { reason });
    return { ok: true };
});

fastify.post("/api/admin/clients/unblock", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const clientId = normalizeClientId(body.clientId);
    if (!clientId) {
        return reply.code(400).send({ error: "Invalid client id." });
    }

    await updateAdminState((draft) => {
        delete draft.blockedClients[clientId];
        return draft;
    });

    notifyClient(clientId, "unblocked", {});
    return { ok: true };
});

fastify.setNotFoundHandler((res, reply) => {
    return reply.code(404).type("text/html").sendFile("404.html");
});

// HTTP to HTTPS Redirector (Optional but highly recommended)
createHttpServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
    res.end();
}).listen(80);

fastify.server.on("listening", () => {
    console.log("-----------------------------------------");
    console.log("Vortex Proxy is SECURE and LIVE");
    console.log("URL: https://vortexunblocker.duckdns.org");
    console.log("-----------------------------------------");
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
    fastify.close();
    process.exit(0);
}

// Oracle uses 443 for HTTPS
fastify.listen({
    port: 443,
    host: "0.0.0.0", // Listen on all network interfaces
});
