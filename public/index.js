"use strict";

const form = document.getElementById("sj-form");
const address = document.getElementById("sj-address");
const searchEngine = document.getElementById("sj-search-engine");
const error = document.getElementById("sj-error");
const errorCode = document.getElementById("sj-error-code");
const container = document.getElementById("frame-container"); // NEW: Target container

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
    files: {
        wasm: "/scram/scramjet.wasm.wasm",
        all: "/scram/scramjet.all.js",
        sync: "/scram/scramjet.sync.js",
    },
});

scramjet.init();

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

function goHome() {
    container.innerHTML = `
        <div id="landing-state">
            <div class="welcome-content">
                <h2>Welcome to Vortex</h2>
                <p>Enter a URL or search term in the bar above to begin browsing.</p>
            </div>
        </div>`;
    address.value = ""; 
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
        await registerSW();
    } catch (err) {
        error.textContent = "Failed to register service worker.";
        errorCode.textContent = err.toString();
        throw err;
    }

    const url = search(address.value, searchEngine.value);

    let wispUrl =
        (location.protocol === "https:" ? "wss" : "ws") +
        "://" +
        location.host +
        "/wisp/";
        
    if ((await connection.getTransport()) !== "/libcurl/index.mjs") {
        await connection.setTransport("/libcurl/index.mjs", [
            { websocket: wispUrl },
        ]);
    }

    // Clear previous frames if the user searches again
    container.innerHTML = "";

    const frame = scramjet.createFrame();
    frame.frame.id = "sj-frame";
    
    // CHANGE: Append to container instead of document.body
    container.appendChild(frame.frame); 
    
// ... your existing code ...
    frame.go(url);

    // NEW: Update the address bar when the site changes
    frame.frame.addEventListener('load', () => {
        try {
            const currentPath = frame.frame.contentWindow.location.pathname;
            
            // Scramjet usually stores the encoded URL after the prefix (e.g., /search/ENCODED_URL)
            // We need to strip the prefix to get the encoded part
            const encodedPart = currentPath.split('/search/')[1]; 
            
            if (encodedPart) {
                // Decode the URL so it looks normal (e.g., https://google.com)
                const decodedUrl = scramjet.decodeUrl(encodedPart);
                address.value = decodedUrl;
            }
        } catch (e) {
            // This might fail due to Cross-Origin restrictions on some sites, 
            // but Scramjet usually handles this via the service worker.
            console.error("Could not update address bar:", e);
        }
    });
});