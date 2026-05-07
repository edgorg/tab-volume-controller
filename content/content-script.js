// Store references to audio contexts and gain nodes
const audioContextMap = new WeakMap();
let currentVolume = 1.0;
let isMuted = false;

// Create or retrieve a GainNode for a media element
function getOrCreateGain(element) {
  if (audioContextMap.has(element)) {
    return audioContextMap.get(element);
  }

  // Create a new AudioContext and route the media through a GainNode
  const audioContext = new AudioContext();
  const source = audioContext.createMediaElementSource(element);
  const gainNode = audioContext.createGain();

  source.connect(gainNode);
  gainNode.connect(audioContext.destination);

  const entry = { audioContext, gainNode };
  audioContextMap.set(element, entry);
  return entry;
}

// Apply volume to all media elements on the page
function applyVolume() {
  const mediaElements = document.querySelectorAll("audio, video");
  mediaElements.forEach(element => {
    const { gainNode } = getOrCreateGain(element);
    gainNode.gain.value = isMuted ? 0 : currentVolume;
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

// Apply on initial load in case media is already playing
applyVolume();