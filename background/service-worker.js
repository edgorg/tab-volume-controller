// Track tabs we've already injected into
const injectedTabs = new Set();

// Track tabs we're actively managing
const managedTabs = new Set();

// Track tabs that have had presets applied
const presetAppliedTabs = new Set();

// --- Icon Theming ---

function updateIcon(isDark) {
    const suffix = isDark ? "dark" : "light";
    chrome.action.setIcon({
        path: {
            "16": `icons/icon16-${suffix}.png`,
            "48": `icons/icon48-${suffix}.png`,
            "128": `icons/icon128-${suffix}.png`
        }
    });
}

// --- Content Script Injection ---

async function ensureContentScript(tabId) {
    if (injectedTabs.has(tabId)) {
        try {
            await chrome.tabs.sendMessage(tabId, { type: "PING" });
            return;
        } catch {
            injectedTabs.delete(tabId);
        }
    }

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content/content-script.js"]
        });
        injectedTabs.add(tabId);
    } catch (e) {
        console.warn(`Could not inject into tab ${tabId}:`, e.message);
    }
}

// --- Volume Application ---

async function applyVolumeToTab(tab) {
    const data = await chrome.storage.local.get(["tabVolumes", "sitePresets", "presetsEnabled"]);
    const tabVolumes = data.tabVolumes || {};
    const sitePresets = data.sitePresets || {};
    const presetsEnabled = data.presetsEnabled !== false;

    let hostname = null;
    try {
        hostname = new URL(tab.url).hostname;
    } catch {
        return;
    }

    // Check for existing tab volume first, then site preset (if enabled)
    const tabSettings = tabVolumes[tab.id];
    const sitePreset = (hostname && presetsEnabled) ? sitePresets[hostname] : null;
    const settings = tabSettings || sitePreset;

    if (!settings) return;

    await ensureContentScript(tab.id);

    // Small delay to let content script initialize
    setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, {
            type: "SET_VOLUME",
            volume: settings.muted ? 0 : settings.volume
        });

        if (settings.muted) {
            chrome.tabs.sendMessage(tab.id, {
                type: "SET_MUTE",
                muted: true
            });
        }
    }, 100);
}

// --- Tab Tracking ---

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.audible === true) {
        managedTabs.add(tabId);
        applyVolumeToTab(tab);
    }

    // Also handle page refresh — content script is destroyed
    if (changeInfo.status === "complete" && managedTabs.has(tabId)) {
        injectedTabs.delete(tabId); // Content script was destroyed by refresh
        applyVolumeToTab(tab);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    injectedTabs.delete(tabId);
    managedTabs.delete(tabId);
    presetAppliedTabs.delete(tabId);
});

// --- Message Handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "THEME_UPDATE") {
        updateIcon(message.isDark);
        sendResponse({ success: true });
        return true;
    }

    if (message.type === "GET_AUDIO_TABS") {
        chrome.tabs.query({ audible: true }, (audibleTabs) => {
            audibleTabs.forEach(tab => managedTabs.add(tab.id));

            const tabPromises = Array.from(managedTabs).map(tabId =>
                chrome.tabs.get(tabId).catch(() => null)
            );

            Promise.all(tabPromises).then(tabs => {
                const validTabs = tabs
                    .filter(tab => tab !== null)
                    .map(tab => ({
                        id: tab.id,
                        title: tab.title,
                        favIconUrl: tab.favIconUrl || "",
                        url: tab.url || ""
                    }));

                const validIds = new Set(validTabs.map(t => t.id));
                managedTabs.forEach(id => {
                    if (!validIds.has(id)) {
                        managedTabs.delete(id);
                    }
                });

                sendResponse(validTabs);
            });
        });
        return true;
    }

    if (message.type === "SET_VOLUME") {
        managedTabs.add(message.tabId);
        ensureContentScript(message.tabId).then(() => {
            chrome.tabs.sendMessage(message.tabId, {
                type: "SET_VOLUME",
                volume: message.volume
            });
        });
        sendResponse({ success: true });
        return true;
    }

    if (message.type === "SET_MUTE") {
        managedTabs.add(message.tabId);
        ensureContentScript(message.tabId).then(() => {
            chrome.tabs.sendMessage(message.tabId, {
                type: "SET_MUTE",
                muted: message.muted
            });
        });
        sendResponse({ success: true });
        return true;
    }
});