/**
 * 8it Cafe Cloud POS — Service Worker Registration & PWA Lifecycle Manager
 * Handles registration, update detection, skip-waiting triggers, and install prompts.
 */

let deferredInstallPrompt = null;
const installListeners = new Set();
const updateListeners = new Set();

export function register(config = {}) {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  // Capture PWA install prompt for Android tablets & browsers
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installListeners.forEach((listener) => listener(true));
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    installListeners.forEach((listener) => listener(false));
    console.log('[PWA] 8it Cafe POS successfully installed to device.');
  });

  window.addEventListener('load', () => {
    const swUrl = '/sw.js';

    navigator.serviceWorker
      .register(swUrl)
      .then((registration) => {
        // If a worker is already waiting, an update is ready
        if (registration.waiting) {
          notifyUpdateReady(registration, config);
        }

        registration.onupdatefound = () => {
          const installingWorker = registration.installing;
          if (!installingWorker) return;

          installingWorker.onstatechange = () => {
            if (installingWorker.state === 'installed') {
              if (navigator.serviceWorker.controller) {
                // New content available
                notifyUpdateReady(registration, config);
              } else {
                // Content cached for offline shell
                if (config.onSuccess) config.onSuccess(registration);
              }
            }
          };
        };
      })
      .catch((error) => {
        console.warn('[PWA] Service worker registration error:', error);
      });

    // Reload page when new service worker takes control
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });
}

function notifyUpdateReady(registration, config) {
  console.log('[PWA] New version of 8it Cafe POS available.');
  updateListeners.forEach((listener) => listener(registration));
  if (config.onUpdate) {
    config.onUpdate(registration);
  }
}

export function onUpdateAvailable(callback) {
  updateListeners.add(callback);
  return () => updateListeners.delete(callback);
}

export function onInstallPromptAvailable(callback) {
  installListeners.add(callback);
  if (deferredInstallPrompt) callback(true);
  return () => installListeners.delete(callback);
}

export function promptPwaInstall() {
  if (!deferredInstallPrompt) return Promise.resolve(false);
  deferredInstallPrompt.prompt();
  return deferredInstallPrompt.userChoice.then((choiceResult) => {
    const accepted = choiceResult.outcome === 'accepted';
    deferredInstallPrompt = null;
    installListeners.forEach((l) => l(false));
    return accepted;
  });
}

export function activateWaitingWorker(registration) {
  if (registration && registration.waiting) {
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
}

export function unregister() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((registration) => registration.unregister())
      .catch((error) => console.error(error.message));
  }
}
