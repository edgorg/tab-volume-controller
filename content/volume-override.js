(function () {
    if (window.__levelsOverrideInjected) return;
    window.__levelsOverrideInjected = true;

    // --- Determine initial volume ---
    // Priority: 1. Preload from background script (fastest if available)
    //           2. localStorage mirror (synchronous, survives service worker sleep)
    //           3. Default to full volume (no preset)

    let masterVolume = 1.0;
    let masterMuted = false;

    // Check for background-injected preload
    if (window.__levelsPreload) {
        masterVolume = window.__levelsPreload.volume;
        masterMuted = window.__levelsPreload.muted;
    } else {
        // Fall back to localStorage mirror
        try {
            const stored = localStorage.getItem('__levels_settings');
            if (stored) {
                const parsed = JSON.parse(stored);
                // Only apply if it matches the current hostname
                if (parsed.hostname === location.hostname) {
                    masterVolume = parsed.volume;
                    masterMuted = parsed.muted;
                }
            }
        } catch (e) {
            // localStorage blocked or unavailable — stay at defaults
        }
    }

    const originalVolumeDescriptor = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype, 'volume'
    );

    const elementIntendedVolumes = new WeakMap();

    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
        get() {
            if (elementIntendedVolumes.has(this)) {
                return elementIntendedVolumes.get(this);
            }
            return originalVolumeDescriptor.get.call(this);
        },
        set(value) {
            elementIntendedVolumes.set(this, value);
            const adjusted = masterMuted ? 0 : value * masterVolume;
            originalVolumeDescriptor.set.call(this, Math.max(0, Math.min(1, adjusted)));
        },
        configurable: true,
        enumerable: true
    });

    function applyToAll() {
        const allMedia = document.querySelectorAll('video, audio');
        allMedia.forEach(el => {
            const intended = elementIntendedVolumes.get(el) ??
                originalVolumeDescriptor.get.call(el);
            elementIntendedVolumes.set(el, intended);
            const adjusted = masterMuted ? 0 : intended * masterVolume;
            originalVolumeDescriptor.set.call(el, Math.max(0, Math.min(1, adjusted)));
        });
        applyToShadowRoots(document, 0);
    }

    // Traverse shadow roots with depth limit to avoid excessive DOM traversal
    const MAX_SHADOW_DEPTH = 3;

    function applyToShadowRoots(root, depth) {
        if (depth >= MAX_SHADOW_DEPTH) return;

        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                const shadowMedia = el.shadowRoot.querySelectorAll('video, audio');
                shadowMedia.forEach(media => {
                    const intended = elementIntendedVolumes.get(media) ??
                        originalVolumeDescriptor.get.call(media);
                    elementIntendedVolumes.set(media, intended);
                    const adjusted = masterMuted ? 0 : intended * masterVolume;
                    originalVolumeDescriptor.set.call(media, Math.max(0, Math.min(1, adjusted)));
                });
                applyToShadowRoots(el.shadowRoot, depth + 1);
            }
        });
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (!event.data || event.data.direction !== 'levels-to-page') return;

        if (event.data.type === 'SET_VOLUME') {
            masterVolume = event.data.volume;
            applyToAll();
        }

        if (event.data.type === 'SET_MUTE') {
            masterMuted = event.data.muted;
            applyToAll();
        }

        if (event.data.type === 'INIT_SETTINGS') {
            masterVolume = event.data.volume;
            masterMuted = event.data.muted;
            applyToAll();
        }
    });

    // Watch for new media elements
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;

                const mediaElements = [];

                if (node.matches && node.matches('video, audio')) {
                    mediaElements.push(node);
                }

                if (node.querySelectorAll) {
                    mediaElements.push(...node.querySelectorAll('video, audio'));
                }

                mediaElements.forEach(el => {
                    const intended = elementIntendedVolumes.get(el) ??
                        originalVolumeDescriptor.get.call(el);
                    elementIntendedVolumes.set(el, intended);
                    const adjusted = masterMuted ? 0 : intended * masterVolume;
                    originalVolumeDescriptor.set.call(el, Math.max(0, Math.min(1, adjusted)));
                });
            }
        }
    });

    if (document.documentElement) {
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } else {
        const docObserver = new MutationObserver(() => {
            if (document.documentElement) {
                observer.observe(document.documentElement, { childList: true, subtree: true });
                docObserver.disconnect();
            }
        });
        docObserver.observe(document, { childList: true });
    }
})();
