"use strict";

const form = document.getElementById("announcement-form");
const clearBtn = document.getElementById("clear-btn");
const refreshClientsBtn = document.getElementById("refresh-clients-btn");
const adminKeyInput = document.getElementById("admin-key");
const titleInput = document.getElementById("announcement-title");
const messageInput = document.getElementById("announcement-message");
const linkTextInput = document.getElementById("announcement-link-text");
const linkUrlInput = document.getElementById("announcement-link-url");
const statusEl = document.getElementById("status");

const previewEmpty = document.getElementById("preview-empty");
const previewContent = document.getElementById("preview-content");
const previewTitle = document.getElementById("preview-title");
const previewMessage = document.getElementById("preview-message");
const previewLink = document.getElementById("preview-link");

const clientsTable = document.getElementById("clients-table");
const clientsBody = document.getElementById("clients-body");
const clientsEmpty = document.getElementById("clients-empty");
const clientCount = document.getElementById("client-count");
const adminKeyStorageKey = "vortex:admin-key";

function setStatus(message, ok) {
    statusEl.textContent = message;
    statusEl.className = `status ${ok ? "ok" : "err"}`;
}

function renderPreview(announcement) {
    if (!announcement) {
        previewEmpty.hidden = false;
        previewContent.hidden = true;
        previewTitle.textContent = "";
        previewMessage.textContent = "";
        previewLink.hidden = true;
        previewLink.textContent = "";
        previewLink.href = "#";
        return;
    }

    previewEmpty.hidden = true;
    previewContent.hidden = false;
    previewTitle.textContent = announcement.title || "";
    previewMessage.textContent = announcement.message || "";

    if (announcement.linkUrl) {
        previewLink.hidden = false;
        previewLink.href = announcement.linkUrl;
        previewLink.textContent = announcement.linkText || announcement.linkUrl;
    } else {
        previewLink.hidden = true;
        previewLink.textContent = "";
        previewLink.href = "#";
    }
}

function renderClients(clients) {
    clientsBody.textContent = "";
    clientCount.textContent = `${clients.length} connected`;

    if (!clients.length) {
        clientsEmpty.hidden = false;
        clientsTable.hidden = true;
        clientsEmpty.textContent = "No active users.";
        return;
    }

    clientsEmpty.hidden = true;
    clientsTable.hidden = false;

    for (const client of clients) {
        const tr = document.createElement("tr");

        const identityTd = document.createElement("td");
        identityTd.innerHTML = `<code>${client.id}</code><br><span>${client.userAgent || "Unknown browser"}</span>`;

        const networkTd = document.createElement("td");
        networkTd.textContent = client.ip || "unknown";

        const seenTd = document.createElement("td");
        seenTd.textContent = new Date(client.lastSeenAt).toLocaleTimeString();

        const statusTd = document.createElement("td");
        statusTd.textContent = client.blocked
            ? `Blocked (${client.blockReason || "no reason"})`
            : "Active";

        const actionsTd = document.createElement("td");
        const actionWrap = document.createElement("div");
        actionWrap.className = "client-actions";

        const reasonInput = document.createElement("input");
        reasonInput.className = "mini-input";
        reasonInput.placeholder = "Block reason";
        reasonInput.value = client.blockReason || "No reason provided by admin.";

        const blockBtn = document.createElement("button");
        blockBtn.className = "mini-btn";
        blockBtn.type = "button";
        blockBtn.textContent = "Block";
        blockBtn.addEventListener("click", async () => {
            await blockClient(client.id, reasonInput.value);
        });

        const unblockBtn = document.createElement("button");
        unblockBtn.className = "mini-btn secondary";
        unblockBtn.type = "button";
        unblockBtn.textContent = "Unblock";
        unblockBtn.addEventListener("click", async () => {
            await unblockClient(client.id);
        });

        actionWrap.appendChild(reasonInput);
        actionWrap.appendChild(blockBtn);
        actionWrap.appendChild(unblockBtn);
        actionsTd.appendChild(actionWrap);

        tr.appendChild(identityTd);
        tr.appendChild(networkTd);
        tr.appendChild(seenTd);
        tr.appendChild(statusTd);
        tr.appendChild(actionsTd);
        clientsBody.appendChild(tr);
    }
}

async function jsonFetch(path, options = {}) {
    const response = await fetch(path, options);
    let payload = null;
    try {
        payload = await response.json();
    } catch {}

    if (!response.ok) {
        const errorMessage =
            payload && payload.error
                ? payload.error
                : `Request failed (${response.status})`;
        throw new Error(errorMessage);
    }

    return payload;
}

function getAdminKey() {
    return adminKeyInput.value.trim();
}

function getAdminHeaders(json = false) {
    const headers = {
        "x-admin-key": getAdminKey(),
    };
    if (json) {
        headers["content-type"] = "application/json";
    }
    return headers;
}

async function loadCurrentAnnouncement() {
    try {
        const payload = await jsonFetch("/api/announcements/latest", {
            cache: "no-store",
        });
        renderPreview(payload.announcement || null);
    } catch (err) {
        setStatus(`Load failed: ${err.message}`, false);
    }
}

async function publishAnnouncement(event) {
    event.preventDefault();

    if (!getAdminKey()) {
        setStatus("Enter your admin key.", false);
        return;
    }

    const payload = {
        title: titleInput.value,
        message: messageInput.value,
        linkText: linkTextInput.value,
        linkUrl: linkUrlInput.value,
    };

    try {
        const result = await jsonFetch("/api/announcements/latest", {
            method: "POST",
            headers: getAdminHeaders(true),
            body: JSON.stringify(payload),
        });
        renderPreview(result.announcement || null);
        setStatus("Announcement published.", true);
    } catch (err) {
        setStatus(err.message || "Publish failed.", false);
    }
}

async function clearAnnouncement() {
    if (!getAdminKey()) {
        setStatus("Enter your admin key first.", false);
        return;
    }

    try {
        await jsonFetch("/api/announcements/latest", {
            method: "DELETE",
            headers: getAdminHeaders(false),
        });
        renderPreview(null);
        setStatus("Announcement cleared.", true);
    } catch (err) {
        setStatus(err.message || "Clear failed.", false);
    }
}

async function loadClients() {
    if (!getAdminKey()) {
        clientsEmpty.hidden = false;
        clientsEmpty.textContent = "Enter your admin key to load users.";
        clientsTable.hidden = true;
        clientCount.textContent = "0 connected";
        return;
    }

    try {
        const payload = await jsonFetch("/api/admin/clients", {
            headers: getAdminHeaders(false),
            cache: "no-store",
        });
        renderClients(payload.clients || []);
    } catch (err) {
        setStatus(err.message || "Failed to load users.", false);
    }
}

async function blockClient(clientId, reason) {
    if (!getAdminKey()) {
        setStatus("Enter your admin key first.", false);
        return;
    }
    try {
        await jsonFetch("/api/admin/clients/block", {
            method: "POST",
            headers: getAdminHeaders(true),
            body: JSON.stringify({
                clientId,
                reason,
            }),
        });
        setStatus(`Blocked ${clientId}`, true);
        await loadClients();
    } catch (err) {
        setStatus(err.message || "Block failed.", false);
    }
}

async function unblockClient(clientId) {
    if (!getAdminKey()) {
        setStatus("Enter your admin key first.", false);
        return;
    }
    try {
        await jsonFetch("/api/admin/clients/unblock", {
            method: "POST",
            headers: getAdminHeaders(true),
            body: JSON.stringify({ clientId }),
        });
        setStatus(`Unblocked ${clientId}`, true);
        await loadClients();
    } catch (err) {
        setStatus(err.message || "Unblock failed.", false);
    }
}

form.addEventListener("submit", publishAnnouncement);
clearBtn.addEventListener("click", clearAnnouncement);
refreshClientsBtn.addEventListener("click", loadClients);

adminKeyInput.addEventListener("input", () => {
    try {
        localStorage.setItem(adminKeyStorageKey, adminKeyInput.value.trim());
    } catch {}
    loadClients();
});
setInterval(loadClients, 5000);

try {
    const storedKey = localStorage.getItem(adminKeyStorageKey) || "";
    if (storedKey) {
        adminKeyInput.value = storedKey;
    }
} catch {}

loadCurrentAnnouncement();
loadClients();
