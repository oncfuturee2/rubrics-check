import { useEffect, useRef, useState } from 'react';

const UI_PREFERENCES_STORAGE_KEY = 'rubrics-ui-preferences.v1';
const MIN_CARD_HEIGHT = 40;
let preferRemotePreferences = false;

function normalizeUiPreferences(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ...source,
    cardHeights: source.cardHeights && typeof source.cardHeights === 'object' ? source.cardHeights : {},
  };
}

async function loadRemoteUiPreferences() {
  const response = await fetch('/api/ui/preferences');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  preferRemotePreferences = true;
  localStorage.removeItem(UI_PREFERENCES_STORAGE_KEY);
  return normalizeUiPreferences(await response.json());
}

async function saveRemoteUiPreferences(preferences) {
  const response = await fetch('/api/ui/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalizeUiPreferences(preferences)),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return normalizeUiPreferences(await response.json());
}

function loadLocalUiPreferences() {
  try {
    return normalizeUiPreferences(JSON.parse(localStorage.getItem(UI_PREFERENCES_STORAGE_KEY) || '{}'));
  } catch (error) {
    return normalizeUiPreferences(null);
  }
}

function saveLocalUiPreferences(preferences) {
  localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(normalizeUiPreferences(preferences)));
}

function isNearResizeHandle(event, element) {
  const rect = element.getBoundingClientRect();
  return event.clientY >= rect.bottom - 28 && event.clientX >= rect.left && event.clientX <= rect.right;
}

export function usePersistentElementHeights(rootRef, namespace, dependencyKey = '') {
  const [preferences, setPreferences] = useState(null);
  const latestPreferencesRef = useRef(normalizeUiPreferences(null));
  const activeResizeKeyRef = useRef(null);
  const saveTimerRef = useRef(null);
  const clearResizeTimerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    loadRemoteUiPreferences()
      .catch(() => loadLocalUiPreferences())
      .then((loaded) => {
        if (cancelled) return;
        latestPreferencesRef.current = loaded;
        setPreferences(loaded);
      });

    return () => {
      cancelled = true;
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (clearResizeTimerRef.current) window.clearTimeout(clearResizeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !preferences) return undefined;

    const elements = Array.from(root.querySelectorAll('[data-ui-height-key]'));
    if (!elements.length) return undefined;

    function scheduleSave(nextPreferences) {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        if (preferRemotePreferences) {
          saveRemoteUiPreferences(nextPreferences).catch(() => saveLocalUiPreferences(nextPreferences));
        } else {
          saveLocalUiPreferences(nextPreferences);
        }
      }, 350);
    }

    function clearActiveResize() {
      if (clearResizeTimerRef.current) window.clearTimeout(clearResizeTimerRef.current);
      clearResizeTimerRef.current = window.setTimeout(() => {
        activeResizeKeyRef.current = null;
        document.documentElement.classList.remove('ui-card-resizing');
      }, 220);
    }

    function handlePointerDown(event) {
      if (!isNearResizeHandle(event, event.currentTarget)) return;
      const key = event.currentTarget.getAttribute('data-ui-height-key');
      if (!key) return;
      activeResizeKeyRef.current = `${namespace}.${key}`;
      document.documentElement.classList.add('ui-card-resizing');
      window.addEventListener('pointerup', clearActiveResize, { once: true });
      window.addEventListener('pointercancel', clearActiveResize, { once: true });
    }

    elements.forEach((element) => {
      const key = element.getAttribute('data-ui-height-key');
      const stored = preferences.cardHeights?.[`${namespace}.${key}`];
      const height = Number(stored);
      if (Number.isFinite(height) && height >= MIN_CARD_HEIGHT) {
        element.style.height = `${Math.round(height)}px`;
      }
      element.addEventListener('pointerdown', handlePointerDown);
    });

    let observing = false;
    const observer = new ResizeObserver((entries) => {
      if (!observing || !activeResizeKeyRef.current) return;

      const nextHeights = { ...(latestPreferencesRef.current.cardHeights || {}) };
      let changed = false;

      entries.forEach((entry) => {
        const key = entry.target.getAttribute('data-ui-height-key');
        const storedKey = key ? `${namespace}.${key}` : '';
        if (!storedKey || storedKey !== activeResizeKeyRef.current) return;

        const height = Math.round(entry.target.getBoundingClientRect().height || entry.contentRect.height);
        if (!Number.isFinite(height) || height < MIN_CARD_HEIGHT || nextHeights[storedKey] === height) return;

        nextHeights[storedKey] = height;
        changed = true;
      });

      if (!changed) return;
      const nextPreferences = { ...latestPreferencesRef.current, cardHeights: nextHeights };
      latestPreferencesRef.current = nextPreferences;
      scheduleSave(nextPreferences);
    });

    const frame = window.requestAnimationFrame(() => {
      observing = true;
      elements.forEach((element) => observer.observe(element));
    });

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      elements.forEach((element) => element.removeEventListener('pointerdown', handlePointerDown));
      window.removeEventListener('pointerup', clearActiveResize);
      window.removeEventListener('pointercancel', clearActiveResize);
    };
  }, [rootRef, preferences, namespace, dependencyKey]);
}
