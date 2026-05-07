// Track tabs we've already injected into
const injectedTabs = new Set();

// Track tabs we're actively managing
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

// --- Tab Tracking ---

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.audible === true) {
        managedTabs.add(tabId);
        ensureContentScript(tabId);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    injectedTabs.delete(tabId);
    managedTabs.delete(tabId);
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