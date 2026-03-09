import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "url";
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

// SSL Configuration for all Haven.best subdomains
const sslOptions = {
    cert: readFileSync("/etc/letsencrypt/live/haven.best/fullchain.pem"),
    key: readFileSync("/etc/letsencrypt/live/haven.best/privkey.pem")
};

const fastify = Fastify({
    serverFactory: (handler) => {
        return createHttpsServer(sslOptions, handler)
            .on("upgrade", (req, socket, head) => {
                if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
                else socket.end();
            });
    },
});

// Static file serving
fastify.register(fastifyStatic, { root: publicPath, decorateReply: true });
fastify.register(fastifyStatic, { root: scramjetPath, prefix: "/scram/", decorateReply: false });
fastify.register(fastifyStatic, { root: libcurlPath, prefix: "/libcurl/", decorateReply: false });
fastify.register(fastifyStatic, { root: baremuxPath, prefix: "/baremux/", decorateReply: false });

fastify.setNotFoundHandler((res, reply) => {
    return reply.code(404).type("text/html").sendFile("404.html");
});

// HTTP to HTTPS Redirector (Optional but highly recommended)
createHttpServer((req, res) => {
    res.writeHead(301, { "Location": `https://${req.headers.host}${req.url}` });
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
