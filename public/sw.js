importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
let configReady = null;
const blockedHosts = new Set([
	"ads.pubmatic.com",
	"image6.pubmatic.com",
	"eus.rubiconproject.com",
	"id.rlcdn.com",
	"idsync.rlcdn.com",
	"ib.adnxs.com",
	"secure.adnxs.com",
	"sync.inmobi.com",
	"onetag-sys.com",
	"a.amxrtb.com",
	"prebid.a-mo.net",
	"openrtb-us-east-1.axonix.com",
	"ads.us.e-planning.net",
	"u-ams03.e-planning.net",
	"u-ams.4dex.io",
	"hbx.media.net",
	"t.adx.opera.com",
	"dsp-service.admatic.de",
	"prebid.admatic.de",
	"ms-cookie-sync.presage.io",
	"pbs.yahoo.com",
	"cs.krushmedia.com",
	"cpm.vistarsagency.com",
	"ad.mrtnsvr.com",
]);

function getTargetUrl(requestUrl) {
	const prefix = "/scramjet/";
	const local = new URL(requestUrl);
	if (!local.pathname.startsWith(prefix)) return null;
	const encoded = local.pathname.slice(prefix.length);
	if (!encoded) return null;
	try {
		return new URL(decodeURIComponent(encoded));
	} catch {
		return null;
	}
}

function shouldBlockTarget(targetUrl) {
	if (!targetUrl) return false;
	if (blockedHosts.has(targetUrl.hostname)) return true;
	return (
		targetUrl.hostname === "a.poki-cdn.com" &&
		targetUrl.pathname.includes("/prebid/")
	);
}

async function ensureConfig() {
	if (!configReady) configReady = scramjet.loadConfig();
	await configReady;
}

async function handleRequest(event) {
	let routed = false;
	try {
		routed = scramjet.route(event);
	} catch {
		routed = false;
	}

	try {
		const targetUrl = getTargetUrl(event.request.url);
		if (shouldBlockTarget(targetUrl)) {
			return new Response("", { status: 204 });
		}

		await ensureConfig();
		if (routed) {
			return await scramjet.fetch(event);
		}
		return fetch(event.request);
	} catch {
		if (!routed) {
			return fetch(event.request);
		}
		return new Response("Proxy fetch failed", {
			status: 502,
			statusText: "Bad Gateway",
		});
	}
}

self.addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event));
});

self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});
