const tabList = document.getElementById("tab-list");
const emptyState = document.getElementById("empty-state");
const boostCheckbox = document.getElementById("boost-checkbox");
const resetAllBtn = document.getElementById("reset-all");

let boostEnabled = false;
let tabVolumes = {}; // { tabId: { volume: 0.0-6.0, muted: bool } }
let sitePresets = {}; // { hostname: { volume: 0.0-6.0, muted: bool } }
let isInteracting = false;
let currentTabIds = [];

// Load saved settings from storage
async function loadSettings() {
    const data = await chrome.storage.local.get(["boostEnabled", "tabVolumes", "sitePresets"]);
    boostEnabled = data.boostEnabled || false;
    tabVolumes = data.tabVolumes || {};
    sitePresets = data.sitePresets || {};
    boostCheckbox.checked = boostEnabled;
}

// Save settings to storage
async function saveSettings() {
    await chrome.storage.local.set({ boostEnabled, tabVolumes, sitePresets });
}

// Get volume icon SVG based on level and mute state
function getVolumeIcon(volume, muted) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("viewBox", "0 -960 960 960");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");

    if (muted || volume === 0) {
        path.setAttribute("d", "M792-56 671-177q-25 16-53 27.5T560-131v-82q14-5 27.5-10t25.5-12L480-368v208L280-360H120v-240h128L56-792l56-56 736 736-56 56Zm-8-232-58-58q17-31 25.5-65t8.5-70q0-94-55-168T560-749v-82q124 28 202 125.5T840-481q0 53-14.5 102T784-288ZM650-422l-90-90v-130q47 22 73.5 66t26.5 96q0 15-2.5 29.5T650-422ZM480-592 376-696l104-104v208Z");
    } else if (volume < 0.1) {
        path.setAttribute("d", "M200-360v-240h160l200-200v640L360-360H200Z");
    } else if (volume < 0.6) {
        path.setAttribute("d", "M200-360v-240h160l200-200v640L360-360H200Zm440 40v-322q47 22 73.5 66t26.5 96q0 51-26.5 94.5T640-320Z");
    } else {
        path.setAttribute("d", "M560-131v-82q90-26 145-100t55-168q0-94-55-168T560-749v-82q124 28 202 125.5T840-481q0 127-78 224.5T560-131ZM120-360v-240h160l200-200v640L280-360H120Zm440 40v-322q47 22 73.5 66t26.5 96q0 51-26.5 94.5T640-320Z");
    }

    svg.appendChild(path);
    return svg;
}

// Render a single tab row
function createTabRow(tab) {
    const settings = tabVolumes[tab.id] || { volume: 1.0, muted: false };
    const maxValue = boostEnabled ? 5.0 : 1.0;

    // Clamp volume to current max
    if (settings.volume > maxValue) {
        settings.volume = maxValue;
    }

    const row = document.createElement("div");
    row.className = "tab-row";

    const percentDisplay = Math.round(settings.volume * 100);

    row.innerHTML = `
    <img 
      class="tab-favicon" 
      src="${tab.favIconUrl || "icons/icon16-light.png"}" 
      alt=""
      onerror="this.src='icons/icon16-light.png'"
    >
    <div class="tab-info">
      <div class="tab-title" title="${tab.title}">${tab.title}</div>
      <div class="slider-row">
        <input 
          type="range" 
          class="volume-slider" 
          min="0" 
          max="${maxValue * 100}" 
          value="${settings.volume * 100}"
        >
        <span class="volume-label">${percentDisplay}%</span>
      </div>
    </div>
    <button class="mute-btn" title="${settings.muted ? "Unmute" : "Mute"}">
    </button>
  `;

    // Get references to interactive elements
    const slider = row.querySelector(".volume-slider");
    const label = row.querySelector(".volume-label");
    const muteBtn = row.querySelector(".mute-btn");

    // Set initial icon
    muteBtn.appendChild(getVolumeIcon(settings.volume, settings.muted));

    // Track when user is interacting with slider
    slider.addEventListener("mousedown", () => { isInteracting = true; });
    slider.addEventListener("mouseup", () => { isInteracting = false; });
    slider.addEventListener("mouseleave", () => { isInteracting = false; });

    // Slider input handler
    slider.addEventListener("input", (e) => {
        const volume = parseInt(e.target.value) / 100;
        settings.volume = volume;
        tabVolumes[tab.id] = settings;
        label.textContent = `${Math.round(volume * 100)}%`;
        muteBtn.replaceChildren(getVolumeIcon(volume, settings.muted));

        chrome.runtime.sendMessage({
            type: "SET_VOLUME",
            tabId: tab.id,
            volume: settings.muted ? 0 : volume
        });

        saveSettings();
    });

    // Mute button handler
    muteBtn.addEventListener("click", () => {
        settings.muted = !settings.muted;
        tabVolumes[tab.id] = settings;
        muteBtn.replaceChildren(getVolumeIcon(settings.volume, settings.muted));
        muteBtn.title = settings.muted ? "Unmute" : "Mute";

        chrome.runtime.sendMessage({
            type: "SET_MUTE",
            tabId: tab.id,
            muted: settings.muted
        });

        saveSettings();
    });

    return row;
}

// Render the full tab list
function renderTabs(tabs) {
    tabList.innerHTML = "";

    if (tabs.length === 0) {
        tabList.classList.add("hidden");
        emptyState.classList.remove("hidden");
        return;
    }

    tabList.classList.remove("hidden");
    emptyState.classList.add("hidden");

    tabs.forEach(tab => {
        tabList.appendChild(createTabRow(tab));
    });
}

// Fetch audible tabs and render
let currentTabIds = [];

async function refreshTabs(force = false) {
    if (isInteracting) return;

    chrome.runtime.sendMessage({ type: "GET_AUDIO_TABS" }, (tabs) => {
        const newTabs = tabs || [];
        const newTabIds = newTabs.map(t => t.id).sort();

        if (force || JSON.stringify(newTabIds) !== JSON.stringify(currentTabIds)) {
            currentTabIds = newTabIds;
            renderTabs(newTabs);
        }
    });
}

// Reset all tabs to 100%
function resetAll() {
    chrome.runtime.sendMessage({ type: "GET_AUDIO_TABS" }, (tabs) => {
        const allTabs = tabs || [];

        allTabs.forEach(tab => {
            tabVolumes[tab.id] = { volume: 1.0, muted: false };

            chrome.runtime.sendMessage({
                type: "SET_VOLUME",
                tabId: tab.id,
                volume: 1.0
            });

            chrome.runtime.sendMessage({
                type: "SET_MUTE",
                tabId: tab.id,
                muted: false
            });
        });

        saveSettings();
        refreshTabs(true);
    });
}

// Reset all button handler
resetAllBtn.addEventListener("click", resetAll);

// Boost toggle handler
boostCheckbox.addEventListener("change", (e) => {
    boostEnabled = e.target.checked;

    // If boost was disabled, clamp all volumes to 1.0 and notify tabs
    if (!boostEnabled) {
        Object.keys(tabVolumes).forEach(tabId => {
            if (tabVolumes[tabId].volume > 1.0) {
                tabVolumes[tabId].volume = 1.0;

                chrome.runtime.sendMessage({
                    type: "SET_VOLUME",
                    tabId: parseInt(tabId),
                    volume: tabVolumes[tabId].muted ? 0 : 1.0
                });
            }
        });
    }

    saveSettings();
    refreshTabs(true);
});

// Update extension icon based on current theme
function updateExtensionIcon() {
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const suffix = isDark ? "dark" : "light";
    chrome.action.setIcon({
        path: {
            "16": chrome.runtime.getURL(`icons/icon16-${suffix}.png`),
            "48": chrome.runtime.getURL(`icons/icon48-${suffix}.png`),
            "128": chrome.runtime.getURL(`icons/icon128-${suffix}.png`)
        }
    });
}

// Initial load
loadSettings().then(() => {
    refreshTabs();
    updateExtensionIcon();
});

// Poll for changes every second while popup is open
setInterval(refreshTabs, 1000);