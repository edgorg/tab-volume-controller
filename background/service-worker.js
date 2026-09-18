const injectedTabs = new Set();
const managedTabs = new Set();

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

// --- Settings Lookup ---

async function getSettingsForTab(tab) {
    const data = await chrome.storage.local.get(["tabVolumes", "sitePresets", "presetsEnabled"]);
    const tabVolumes = data.tabVolumes || {};
    const sitePresets = data.sitePresets || {};
    const presetsEnabled = data.presetsEnabled !== false;

    let hostname = null;
    try {
        hostname = new URL(tab.url).hostname;
    } catch {
        return null;
    }

    const tabSettings = tabVolumes[tab.id];
    const sitePreset = (hostname && presetsEnabled) ? sitePresets[hostname] : null;
    return tabSettings || sitePreset || null;
}

// --- Preload Injection ---
// Injects the saved volume BEFORE volume-override.js reads it

async function injectPreload(tabId, settings) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: "MAIN",
            injectImmediately: true,
            func: (volume, muted) => {
                window.__levelsPreload = { volume, muted };
            },
            args: [settings.volume, settings.muted]
        });
    } catch (e) {
        // Tab may not be ready yet, that's ok — content script will handle it
    }
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
            target: { tabId, allFrames: true },
            files: ["content/volume-override.js"],
            world: "MAIN"
        });

        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ["content/content-script.js"]
        });

        injectedTabs.add(tabId);
    } catch (e) {
        console.warn(`[Levels] Could not inject into tab ${tabId}:`, e.message);
    }
}

// --- Volume Application (waits for content script ready) ---

async function applyVolumeToTab(tab) {
    const settings = await getSettingsForTab(tab);
    if (!settings) return;

    await ensureContentScript(tab.id);

    // Wait for content script to acknowledge readiness
    try {
        await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    } catch {
        // Content script not ready — retry once after brief delay
        await new Promise(r => setTimeout(r, 150));
        try {
            await chrome.tabs.sendMessage(tab.id, { type: "PING" });
        } catch {
            return; // Give up — content script not responding
        }
    }

    chrome.tabs.sendMessage(tab.id, {
        type: "SET_MUTE",
        muted: settings.muted
    }).catch(() => {});

    chrome.tabs.sendMessage(tab.id, {
        type: "SET_VOLUME",
        volume: settings.volume
    }).catch(() => {});
}

// --- Tab Tracking ---

const applyTimers = new Map(); // tabId → timeout handle

// Debounce volume application per tab to avoid double-calls
// when audible + complete fire in quick succession
function debouncedApplyVolume(tab) {
    if (applyTimers.has(tab.id)) {
        clearTimeout(applyTimers.get(tab.id));
    }
    applyTimers.set(tab.id, setTimeout(() => {
        applyTimers.delete(tab.id);
        applyVolumeToTab(tab);
    }, 100));
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // When navigation starts, preload the volume before anything else runs
    if (changeInfo.status === "loading" && tab.url) {
        const settings = await getSettingsForTab(tab);
        if (settings) {
            await injectPreload(tabId, settings);
        }
    }

    if (changeInfo.audible === true) {
        managedTabs.add(tabId);
        debouncedApplyVolume(tab);
    }

    if (changeInfo.status === "complete" && managedTabs.has(tabId)) {
        injectedTabs.delete(tabId);
        debouncedApplyVolume(tab);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    injectedTabs.delete(tabId);
    managedTabs.delete(tabId);
    if (applyTimers.has(tabId)) {
        clearTimeout(applyTimers.get(tabId));
        applyTimers.delete(tabId);
    }
});

// --- Message Handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "THEME_UPDATE") {
        updateIcon(message.isDark);
        sendResponse({ success: true });
        return true;
    }

    if (message.type === "GET_OWN_TAB_ID") {
        sendResponse({ tabId: sender.tab?.id ?? null });
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
            }).catch(() => {});
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
            }).catch(() => {});
        });
        sendResponse({ success: true });
        return true;
    }

    if (message.type === "CLEANUP_TAB_VOLUMES") {
        // Remove stale tabVolumes entries for tabs that no longer exist
        const validTabIds = message.validTabIds || [];
        chrome.storage.local.get(["tabVolumes"], (data) => {
            const tabVolumes = data.tabVolumes || {};
            const validSet = new Set(validTabIds.map(id => String(id)));
            let changed = false;

            Object.keys(tabVolumes).forEach(key => {
                if (!validSet.has(key)) {
                    delete tabVolumes[key];
                    changed = true;
                }
            });

            if (changed) {
                chrome.storage.local.set({ tabVolumes });
            }
            sendResponse({ success: true, cleaned: changed });
        });
        return true;
    }
});
