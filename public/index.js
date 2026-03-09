"use strict";

const form = document.getElementById("sj-form");
const address = document.getElementById("sj-address");
const searchEngine = document.getElementById("sj-search-engine");
const error = document.getElementById("sj-error");
const errorCode = document.getElementById("sj-error-code");
const container = document.getElementById("frame-container");

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

// --- Internal Navigation Logic ---

async function launchUrl(targetUrl) {
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
});

// Updated openApp to use the existing scramjet instance
async function openApp(url) {
    toggleApps(); // Close the modal
    await launchUrl(url); // Launch via the frame logic
}

// --- Browser-like Functions ---

function goHome() {
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

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = search(address.value, searchEngine.value);
    await launchUrl(url);
});

// --- Tab & Navigation Guards ---

function installTopLevelSingleTabGuards() {
    window.open = (url) => openInCurrentFrame(url) || null;
    document.addEventListener("click", (event) => {
        const link = event.target?.closest?.("a[href]");
        if (!link || !currentFrame) return;
        const href = link.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
        event.preventDefault();
        currentFrame.go(link.href);
    }, true);
}

function openInCurrentFrame(url, fallbackBase = window.location.href) {
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

function goBack() {
    if (currentFrame) {
        const win = currentFrame.frame.contentWindow;
        if (win) win.history.back();
    }
}

function goForward() {
    if (currentFrame) {
        const win = currentFrame.frame.contentWindow;
        if (win) win.history.forward();
    }
}

function refresh() {
    if (currentFrame) {
        currentFrame.go(currentFrame.frame.contentWindow.location.href);
    }
}
