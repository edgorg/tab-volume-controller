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

    // --- Web Audio API boost ---
    // Native HTMLMediaElement.volume is clamped to [0, 1] by the browser,
    // so we use a GainNode to amplify beyond 100%.

    const audioContexts = new WeakMap(); // element → { context, gainNode, source }

    function getOrCreateGainNode(el) {
        if (audioContexts.has(el)) {
            return audioContexts.get(el);
        }

        try {
            const context = new AudioContext();
            const source = context.createMediaElementSource(el);
            const gainNode = context.createGain();

            // Add a compressor to tame harsh clipping at high gain levels
            const compressor = context.createDynamicsCompressor();
            compressor.threshold.setValueAtTime(-6, context.currentTime);
            compressor.knee.setValueAtTime(12, context.currentTime);
            compressor.ratio.setValueAtTime(8, context.currentTime);
            compressor.attack.setValueAtTime(0.003, context.currentTime);
            compressor.release.setValueAtTime(0.15, context.currentTime);

            source.connect(gainNode);
            gainNode.connect(compressor);
            compressor.connect(context.destination);

            const entry = { context, gainNode, source, compressor };
            audioContexts.set(el, entry);
            return entry;
        } catch (e) {
            // createMediaElementSource can fail for cross-origin media
            // or elements that already have a source node
            return null;
        }
    }

    function applyVolume(el) {
        const intended = elementIntendedVolumes.get(el) ??
            originalVolumeDescriptor.get.call(el);
        elementIntendedVolumes.set(el, intended);

        if (masterMuted) {
            originalVolumeDescriptor.set.call(el, 0);
            return;
        }

        const effective = intended * masterVolume;

        if (effective <= 1.0) {
            // Normal range — use native volume directly
            originalVolumeDescriptor.set.call(el, Math.max(0, effective));

            // If a GainNode was previously created, reset it to unity
            const existing = audioContexts.get(el);
            if (existing) {
                existing.gainNode.gain.value = 1.0;
            }
        } else {
            // Boost range — set native volume to max, apply excess via GainNode
            originalVolumeDescriptor.set.call(el, Math.max(0, Math.min(1, intended)));

            const audio = getOrCreateGainNode(el);
            if (audio) {
                audio.gainNode.gain.value = masterVolume;

                // Resume context if it was suspended (autoplay policy)
                if (audio.context.state === 'suspended') {
                    audio.context.resume().catch(() => {});
                }
            } else {
                // Fallback: can't create audio context, clamp to max native
                originalVolumeDescriptor.set.call(el, 1.0);
            }
        }
    }

    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
        get() {
            if (elementIntendedVolumes.has(this)) {
                return elementIntendedVolumes.get(this);
            }
            return originalVolumeDescriptor.get.call(this);
        },
        set(value) {
            elementIntendedVolumes.set(this, value);
            applyVolume(this);
        },
        configurable: true,
        enumerable: true
    });

    function applyToAll() {
        const allMedia = document.querySelectorAll('video, audio');
        allMedia.forEach(el => applyVolume(el));
        applyToShadowRoots(document, 0);
    }

    // Traverse shadow roots with depth limit to avoid excessive DOM traversal
    const MAX_SHADOW_DEPTH = 3;

    function applyToShadowRoots(root, depth) {
        if (depth >= MAX_SHADOW_DEPTH) return;

        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                const shadowMedia = el.shadowRoot.querySelectorAll('video, audio');
                shadowMedia.forEach(media => applyVolume(media));
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

                mediaElements.forEach(el => applyVolume(el));
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
