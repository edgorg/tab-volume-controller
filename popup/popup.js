const tabList = document.getElementById("tab-list");
const emptyState = document.getElementById("empty-state");
const boostCheckbox = document.getElementById("boost-checkbox");
const superBoostCheckbox = document.getElementById("super-boost-checkbox");
const presetsCheckbox = document.getElementById("presets-checkbox");
const resetAllBtn = document.getElementById("reset-all");
const settingsBtn = document.getElementById("settings-btn");
const settingsDropdown = document.getElementById("settings-dropdown");

let boostEnabled = false;
let superBoostEnabled = false;
let presetsEnabled = true;
let tabVolumes = {};
let sitePresets = {};
let isInteracting = false;
let currentTabIds = [];

// Get current max volume multiplier
function getMaxValue() {
    if (superBoostEnabled) return 10.0;
    if (boostEnabled) return 2.0;
    return 1.0;
}

// Load saved settings from storage
async function loadSettings() {
    const data = await chrome.storage.local.get(["boostEnabled", "superBoostEnabled", "presetsEnabled", "tabVolumes", "sitePresets"]);
    boostEnabled = data.boostEnabled || false;
    superBoostEnabled = data.superBoostEnabled || false;
    presetsEnabled = data.presetsEnabled !== false;
    tabVolumes = data.tabVolumes || {};
    sitePresets = data.sitePresets || {};
    boostCheckbox.checked = boostEnabled;
    superBoostCheckbox.checked = superBoostEnabled;
    presetsCheckbox.checked = presetsEnabled;
}

// Save settings to storage
async function saveSettings() {
    await chrome.storage.local.set({ boostEnabled, superBoostEnabled, presetsEnabled, tabVolumes, sitePresets });
}

// Extract hostname from URL
function getHostname(url) {
    if (!url) return null;
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
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
    const hostname = getHostname(tab.url);
    const preset = hostname ? sitePresets[hostname] : null;
    let isNewTab = false;

    // Use existing tab volume, or site preset, or default
    if (!tabVolumes[tab.id]) {
        isNewTab = true;
        if (preset && presetsEnabled) {
            tabVolumes[tab.id] = { volume: preset.volume, muted: preset.muted };
        } else {
            tabVolumes[tab.id] = { volume: 1.0, muted: false };
        }
    }

    const settings = tabVolumes[tab.id];
    const maxValue = getMaxValue();

    // Apply preset to newly discovered tabs
    if (isNewTab && preset && presetsEnabled) {
        chrome.runtime.sendMessage({
            type: "SET_VOLUME",
            tabId: tab.id,
            volume: settings.muted ? 0 : settings.volume
        });

        if (settings.muted) {
            chrome.runtime.sendMessage({
                type: "SET_MUTE",
                tabId: tab.id,
                muted: true
            });
        }
    }

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
      src="${tab.favIconUrl || chrome.runtime.getURL("icons/icon16-light.png")}" 
      alt=""
      onerror="this.src='${chrome.runtime.getURL("icons/icon16-light.png")}'"
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

    // Update slider fill colour
    function updateSliderFill() {
        const percent = (slider.value / slider.max) * 100;
        slider.style.setProperty("--fill-percent", `${percent}%`);
    }
    updateSliderFill();

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
        updateSliderFill();
        muteBtn.replaceChildren(getVolumeIcon(volume, settings.muted));

        // Save as site preset
        if (hostname && presetsEnabled) {
            sitePresets[hostname] = { volume: settings.volume, muted: settings.muted };
        }

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

        // Save as site preset
        if (hostname && presetsEnabled) {
            sitePresets[hostname] = { volume: settings.volume, muted: settings.muted };
        }

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
async function refreshTabs(force = false) {
    if (isInteracting) return;

    chrome.runtime.sendMessage({ type: "GET_AUDIO_TABS" }, (tabs) => {
        if (chrome.runtime.lastError) {
            renderTabs([]);
            return;
        }

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

// Clamp volumes when boost level is reduced
function clampVolumes(maxValue) {
    Object.keys(tabVolumes).forEach(tabId => {
        if (tabVolumes[tabId].volume > maxValue) {
            tabVolumes[tabId].volume = maxValue;

            chrome.runtime.sendMessage({
                type: "SET_VOLUME",
                tabId: parseInt(tabId),
                volume: tabVolumes[tabId].muted ? 0 : maxValue
            });
        }
    });
}

// Settings dropdown toggle
settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    settingsDropdown.classList.toggle("hidden");
});

// Close dropdown when clicking outside
document.addEventListener("click", (e) => {
    if (!settingsDropdown.contains(e.target) && !settingsBtn.contains(e.target)) {
        settingsDropdown.classList.add("hidden");
    }
});

// Make settings items toggle their checkbox when clicked anywhere on the row
document.querySelectorAll(".settings-item").forEach(item => {
    item.addEventListener("click", (e) => {
        if (e.target.type === "checkbox") return;

        const checkboxId = item.dataset.for;
        const checkbox = document.getElementById(checkboxId);
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change"));
    });
});

// Presets toggle handler
presetsCheckbox.addEventListener("change", (e) => {
    presetsEnabled = e.target.checked;
    saveSettings();
});

// Boost toggle handler
boostCheckbox.addEventListener("change", (e) => {
    boostEnabled = e.target.checked;

    // If boost disabled, also disable super boost
    if (!boostEnabled) {
        superBoostEnabled = false;
        superBoostCheckbox.checked = false;
        clampVolumes(1.0);
    }

    saveSettings();
    refreshTabs(true);
});

// Super boost toggle handler
superBoostCheckbox.addEventListener("change", (e) => {
    superBoostEnabled = e.target.checked;

    // If super boost enabled, also enable regular boost
    if (superBoostEnabled) {
        boostEnabled = true;
        boostCheckbox.checked = true;
    } else {
        // Clamp to regular boost max
        clampVolumes(2.0);
    }

    saveSettings();
    refreshTabs(true);
});

// Reset all button handler
resetAllBtn.addEventListener("click", resetAll);

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
    refreshTabs(true);
    updateExtensionIcon();
});

// Poll for changes every second while popup is open
setInterval(refreshTabs, 1000);