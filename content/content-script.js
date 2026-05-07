// Prevent double-injection
if (window.__levelsInjected) {
    // Already running
} else {
    window.__levelsInjected = true;

    let currentVolume = 1.0;
    let isMuted = false;

    // Track processed elements using a property on the element itself
    const GAIN_KEY = "__levels_gain";

    // Create or retrieve a GainNode for a media element
    function getOrCreateGain(element) {
        // Already processed by us
        if (element[GAIN_KEY]) {
            return element[GAIN_KEY];
        }

        // Already connected to a MediaElementSource by someone else
        if (element.__alreadyConnected) {
            return null;
        }

        try {
            const audioContext = new AudioContext();
            const source = audioContext.createMediaElementSource(element);
            const gainNode = audioContext.createGain();

            source.connect(gainNode);
            gainNode.connect(audioContext.destination);

            const entry = { audioContext, gainNode };
            element[GAIN_KEY] = entry;
            return entry;
        } catch (e) {
            // Mark it so we don't try again
            element.__alreadyConnected = true;
            return null;
        }
    }

    // Apply volume to all media elements on the page
    function applyVolume() {
        const mediaElements = document.querySelectorAll("audio, video");
        mediaElements.forEach(element => {
            const result = getOrCreateGain(element);
            if (!result) return;

            const { gainNode, audioContext } = result;
            const targetVolume = isMuted ? 0 : currentVolume;

            gainNode.gain.cancelScheduledValues(audioContext.currentTime);
            gainNode.gain.linearRampToValueAtTime(
                targetVolume,
                audioContext.currentTime + 0.2
            );
        });
    }

    // Watch for new media elements being added to the page
    const observer = new MutationObserver(() => {
        applyVolume();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Listen for messages from the background service worker
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === "PING") {
            sendResponse({ status: "alive" });
            return;
        }

        if (message.type === "SET_VOLUME") {
            currentVolume = message.volume;
            applyVolume();
            sendResponse({ success: true });
            return;
        }

        if (message.type === "SET_MUTE") {
            isMuted = message.muted;
            applyVolume();
            sendResponse({ success: true });
            return;
        }
    });

    // Apply on initial load
    applyVolume();
}