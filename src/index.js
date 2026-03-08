import { createServer } from "node:http"; // Using HTTP for development
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

// Wisp Configuration
logging.set_level(logging.NONE);
Object.assign(wisp.options, {
    allow_udp_streams: false,
    hostname_blacklist: [/example\.com/],
    dns_servers: ["1.1.1.1", "1.0.0.1"],
});

// No SSL for development
// const sslOptions = {
//     cert: readFileSync("/etc/letsencrypt/live/vortexunblocker.duckdns.org/fullchain.pem"),
//     key: readFileSync("/etc/letsencrypt/live/vortexunblocker.duckdns.org/privkey.pem")
// };

const fastify = Fastify({
    serverFactory: (handler) => {
        // We create the HTTP server
        return createServer()
            .on("request", (req, res) => {
                // These headers are MANDATORY for Scramjet to work
                res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
                res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
                handler(req, res);
            })
            .on("upgrade", (req, socket, head) => {
                if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
                else socket.end();
            });
    },
});

// Static file serving
fastify.register(fastifyStatic, {
    root: publicPath,
    decorateReply: true,
});

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

fastify.setNotFoundHandler((res, reply) => {
    return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", () => {
    const address = fastify.server.address();
    console.log("-----------------------------------------");
    console.log("Vortex Proxy is LIVE");
    console.log(`URL: http://localhost:${address.port}`);
    console.log(`Port: ${address.port}`);
    console.log("-----------------------------------------");
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
    console.log("SIGTERM signal received: closing HTTPS server");
    fastify.close();
    process.exit(0);
}

// Default to port 8080 for HTTP
let port = parseInt(process.env.PORT || "");
if (isNaN(port)) port = 8080;

fastify.listen({
    port: port,
    host: process.env.HOST || "localhost",
});
