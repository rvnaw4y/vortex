"use strict";

const form = document.getElementById("sj-form");
const address = document.getElementById("sj-address");
const searchEngine = document.getElementById("sj-search-engine");
const error = document.getElementById("sj-error");
const errorCode = document.getElementById("sj-error-code");
const container = document.getElementById("frame-container");
const announcementModal = document.getElementById("announcement-modal");
const announcementTitle = document.getElementById("announcement-title");
const announcementMessage = document.getElementById("announcement-message");
const announcementLink = document.getElementById("announcement-link");
const announcementCloseBtn = document.getElementById("announcement-close-btn");
const announcementDismissBtn = document.getElementById("announcement-dismiss-btn");
const blockOverlay = document.getElementById("admin-block-overlay");
const blockOverlayMessage = document.getElementById("admin-block-message");

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
    files: {
        wasm: "/scram/scramjet.wasm.wasm",
        all: "/scram/scramjet.all.js",
        sync: "/scram/scramjet.sync.js",
    },
    flags: {
        "serviceworkers": false,
        "syncxhr": true,
        "strictRewrites": false,
        "rewriterLogs": false,
        "captureErrors": true,
        "cleanErrors": true,
        "scramitize": false,
        "sourceMaps": false,
        "destructurizeRewrites": false,
        "interceptDownloads": false,
        "allowInvalidJs": true,
        "allowFailedIntercepts": true,
        "sslVerify": false
    }
});

scramjet.init();

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

let currentFrame = null;
let proxyBootPromise = null;
const seenAnnouncementStorageKey = "vortex:last-seen-announcement-id";
const clientIdStorageKey = "vortex:client-id";
const heartbeatIntervalMs = 15000;
let statusStream = null;
let heartbeatTimer = null;
let blockedByAdmin = false;
const clientId = getOrCreateClientId();

// --- Internal Navigation Logic ---

async function launchUrl(targetUrl) {
    if (blockedByAdmin) return;

    try {
        await ensureProxyBoot();

        // Clear landing state
        container.innerHTML = "";

        // Create the Proxy Frame
        const frame = scramjet.createFrame();
        frame.frame.id = "sj-frame";
        container.appendChild(frame.frame); 
        
        currentFrame = frame;
        forceSingleTab(frame);
        
        // Go to the encoded URL
        await frame.go(targetUrl);
        
        // Update input field to show the "clean" URL
        address.value = targetUrl;

    } catch (err) {
        error.textContent = "Failed to launch proxy.";
        errorCode.textContent = err.toString();
        console.error(err);
    }
}

async function ensureProxyBoot() {
    if (!proxyBootPromise) {
        proxyBootPromise = (async () => {
            await registerSW();

            const wispUrl =
                (location.protocol === "https:" ? "wss" : "ws") +
                "://" +
                location.host +
                "/wisp/";

            await connection.setTransport("/libcurl/index.mjs", [
                { websocket: wispUrl },
            ]);
        })();
    }

    try {
        await proxyBootPromise;
    } catch (err) {
        proxyBootPromise = null;
        throw err;
    }
}

// --- App Popup Logic ---

function toggleApps() {
    const modal = document.getElementById("apps-modal");
    if (!modal) return;
    modal.style.display = (modal.style.display === "block") ? "none" : "block";
}

// Global click listener to close modal
window.addEventListener("click", (event) => {
    const modal = document.getElementById("apps-modal");
    if (event.target === modal) {
        modal.style.display = "none";
    }
    if (announcementModal && event.target === announcementModal) {
        closeAnnouncement();
    }
});

// Updated openApp to use the existing scramjet instance
async function openApp(url) {
    if (blockedByAdmin) return;
    toggleApps(); // Close the modal
    await launchUrl(url); // Launch via the frame logic
}

// --- Browser-like Functions ---

function goHome() {
    if (blockedByAdmin) return;

    container.innerHTML = `
        <div id="landing-state">
            <div class="welcome-content">
                <h2>Welcome to Vortex</h2>
                <p>Enter a URL or search term in the bar above to begin browsing.</p>
            </div>
        </div>`;
    address.value = ""; 
    currentFrame = null;
}

function getOrCreateClientId() {
    try {
        const existing = localStorage.getItem(clientIdStorageKey);
        if (isValidClientId(existing)) return existing;
    } catch {}

    const generated = createClientId();
    try {
        localStorage.setItem(clientIdStorageKey, generated);
    } catch {}
    return generated;
}

function createClientId() {
    if (crypto?.randomUUID) {
        return crypto.randomUUID().replace(/-/g, "_");
    }
    return `client_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function isValidClientId(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

function setBlockedState(blocked, reason) {
    blockedByAdmin = Boolean(blocked);
    if (blockedByAdmin) {
        const message = reason
            ? `Sorry, you have been blocked by admin.\nReason: ${reason}`
            : "Sorry, you have been blocked by admin.";
        if (blockOverlayMessage) blockOverlayMessage.textContent = message;
    }

    document.body.classList.toggle("user-blocked", blockedByAdmin);

    if (blockedByAdmin) {
        const appsModal = document.getElementById("apps-modal");
        if (appsModal) appsModal.style.display = "none";
        if (announcementModal) announcementModal.style.display = "none";
    }
}

function parseStreamData(event) {
    try {
        return JSON.parse(event.data || "{}");
    } catch {
        return {};
    }
}

async function sendHeartbeat() {
    if (!clientId) return;

    try {
        const response = await fetch("/api/client/heartbeat", {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                clientId,
                page: window.location.pathname,
            }),
        });
        if (!response.ok) return;

        const payload = await response.json();
        setBlockedState(payload?.blocked, payload?.reason);
    } catch (err) {
        console.warn("Heartbeat failed", err);
    }
}

function startHeartbeatLoop() {
    sendHeartbeat();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);
}

function startStatusStream() {
    if (!clientId || typeof EventSource === "undefined") return;

    if (statusStream) {
        statusStream.close();
        statusStream = null;
    }

    statusStream = new EventSource(
        `/api/client/stream?clientId=${encodeURIComponent(clientId)}`
    );

    statusStream.addEventListener("status", (event) => {
        const payload = parseStreamData(event);
        setBlockedState(payload?.blocked, payload?.reason);
    });

    statusStream.addEventListener("blocked", (event) => {
        const payload = parseStreamData(event);
        setBlockedState(true, payload?.reason);
    });

    statusStream.addEventListener("unblocked", () => {
        setBlockedState(false, "");
    });
}

function closeAnnouncement() {
    if (!announcementModal) return;
    announcementModal.style.display = "none";

    const announcementId = announcementModal.dataset.announcementId;
    if (!announcementId) return;

    try {
        localStorage.setItem(seenAnnouncementStorageKey, announcementId);
    } catch {}
}

function showAnnouncement(announcement) {
    if (
        !announcementModal ||
        !announcementTitle ||
        !announcementMessage ||
        !announcementLink
    ) {
        return;
    }

    announcementTitle.textContent = announcement.title || "Announcement";
    announcementMessage.textContent = announcement.message || "";

    if (announcement.linkUrl) {
        announcementLink.hidden = false;
        announcementLink.href = announcement.linkUrl;
        announcementLink.textContent = announcement.linkText || announcement.linkUrl;
    } else {
        announcementLink.hidden = true;
        announcementLink.href = "#";
        announcementLink.textContent = "";
    }

    announcementModal.dataset.announcementId = announcement.id || "";
    announcementModal.style.display = "block";
}

async function checkAnnouncements() {
    try {
        const response = await fetch("/api/announcements/latest", {
            cache: "no-store",
        });
        if (!response.ok) return;

        const payload = await response.json();
        const announcement = payload?.announcement;
        if (!announcement || !announcement.id) return;

        let seenId = "";
        try {
            seenId = localStorage.getItem(seenAnnouncementStorageKey) || "";
        } catch {}

        if (announcement.id === seenId) return;
        showAnnouncement(announcement);
    } catch (err) {
        console.warn("Announcement check failed", err);
    }
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (blockedByAdmin) return;
    const url = search(address.value, searchEngine.value);
    await launchUrl(url);
});

// --- Tab & Navigation Guards ---

function installTopLevelSingleTabGuards() {
    window.open = (url) => openInCurrentFrame(url) || null;
    document.addEventListener("click", (event) => {
        if (blockedByAdmin) return;
        const link = event.target?.closest?.("a[href]");
        if (!link || !currentFrame) return;
        const href = link.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
        event.preventDefault();
        currentFrame.go(link.href);
    }, true);
}

function openInCurrentFrame(url, fallbackBase = window.location.href) {
    if (blockedByAdmin) return null;
    if (!currentFrame) return null;
    try {
        const target = url ? new URL(String(url), fallbackBase).toString() : fallbackBase;
        currentFrame.go(target);
        return currentFrame.frame.contentWindow || window;
    } catch { return null; }
}

function forceSingleTab(frame) {
    const apply = () => {
        const win = frame.frame.contentWindow;
        const doc = frame.frame.contentDocument;
        if (!win || !doc) return;
        win.open = (url) => {
            frame.go(url ? new URL(url, win.location.href).toString() : win.location.href);
            return win;
        };
    };
    frame.frame.addEventListener("load", apply);
}

installTopLevelSingleTabGuards();
checkAnnouncements();
startHeartbeatLoop();
startStatusStream();

if (announcementCloseBtn) {
    announcementCloseBtn.addEventListener("click", closeAnnouncement);
}
if (announcementDismissBtn) {
    announcementDismissBtn.addEventListener("click", closeAnnouncement);
}

function goBack() {
    if (blockedByAdmin) return;
    if (currentFrame) {
        const win = currentFrame.frame.contentWindow;
        if (win) win.history.back();
    }
}

function goForward() {
    if (blockedByAdmin) return;
    if (currentFrame) {
        const win = currentFrame.frame.contentWindow;
        if (win) win.history.forward();
    }
}

function refresh() {
    if (blockedByAdmin) return;
    if (currentFrame) {
        currentFrame.go(currentFrame.frame.contentWindow.location.href);
    }
}
