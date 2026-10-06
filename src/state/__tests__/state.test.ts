import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { hasUnsavedEnhancement, useSession } from '../session';
import { getInstallId, resetInstallIdCache, SETTINGS_STORAGE_KEY, useSettings } from '../settings';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories must use require
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    __store: store,
  };
});

jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `00000000-0000-4000-8000-00000000000${n++}` };
});

const img = (uri: string) => ({ uri, width: 1000, height: 1000 });

describe('settings', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useSettings.setState({ mode: 'enhance', cloudConsent: 'unknown' });
  });

  it('defaults to enhance mode and unknown consent', () => {
    expect(useSettings.getState()).toMatchObject({ mode: 'enhance', cloudConsent: 'unknown' });
  });

  it('persists mode and consent and restores them on reload', async () => {
    useSettings.getState().setMode('creative');
    useSettings.getState().setCloudConsent('granted');
    // Let the persist middleware flush.
    await new Promise((r) => setTimeout(r, 0));
    const saved = (await AsyncStorage.getItem(SETTINGS_STORAGE_KEY))!;
    expect(JSON.parse(saved).state).toEqual({ mode: 'creative', cloudConsent: 'granted' });

    // Simulate a fresh launch: in-memory defaults, storage as the last launch left it.
    useSettings.setState({ mode: 'enhance', cloudConsent: 'unknown' });
    await AsyncStorage.setItem(SETTINGS_STORAGE_KEY, saved);
    await useSettings.persist.rehydrate();
    expect(useSettings.getState()).toMatchObject({ mode: 'creative', cloudConsent: 'granted' });
  });

  it('ignores corrupt persisted values', async () => {
    await AsyncStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ state: { mode: 'ultra', cloudConsent: 'maybe' }, version: 0 }),
    );
    await useSettings.persist.rehydrate();
    expect(useSettings.getState()).toMatchObject({ mode: 'enhance', cloudConsent: 'unknown' });
  });
});

describe('install ID', () => {
  it('is created once and stays stable across calls and cache resets', async () => {
    const first = await getInstallId();
    expect(await getInstallId()).toBe(first);
    resetInstallIdCache();
    expect(await getInstallId()).toBe(first);
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('capture session', () => {
  beforeEach(() => useSession.getState().clear());

  it('starts a session with the original and upload copies', () => {
    useSession.getState().startSession(img('orig'), img('up'), 8);
    expect(useSession.getState()).toMatchObject({ original: { uri: 'orig' }, upload: { uri: 'up' }, captureZoom: 8 });
  });

  it('stores a result for the current request', () => {
    const s = useSession.getState();
    const id = s.beginRequest('enhance');
    s.resolveRequest(id, 'enhance', img('out'));
    expect(useSession.getState()).toMatchObject({
      results: { enhance: { uri: 'out' } },
      shownMode: 'enhance',
      request: { status: 'idle' },
    });
  });

  it('ignores a late result after cancel', () => {
    const s = useSession.getState();
    const id = s.beginRequest('pro');
    s.cancelRequest();
    s.resolveRequest(id, 'pro', img('late'));
    expect(useSession.getState().results).toEqual({});
    expect(useSession.getState().request).toEqual({ status: 'idle' });
  });

  it('ignores a stale result once a newer request starts', () => {
    const s = useSession.getState();
    const first = s.beginRequest('enhance');
    const second = s.beginRequest('pro');
    s.resolveRequest(first, 'enhance', img('stale'));
    s.failRequest(first, 'enhance', { code: 'timeout', message: 'x' });
    expect(useSession.getState().request).toMatchObject({ status: 'pending', id: second });
    expect(useSession.getState().results).toEqual({});
  });

  it('records a failure for the current request', () => {
    const s = useSession.getState();
    const id = s.beginRequest('creative');
    s.failRequest(id, 'creative', { code: 'rate_limited', message: 'limit', retryAt: '2026-10-08T00:00:00Z' });
    expect(useSession.getState().request).toEqual({
      status: 'error',
      mode: 'creative',
      error: { code: 'rate_limited', message: 'limit', retryAt: '2026-10-08T00:00:00Z' },
    });
  });

  it('tracks unsaved enhancements', () => {
    const s = useSession.getState();
    const id = s.beginRequest('enhance');
    s.resolveRequest(id, 'enhance', img('out'));
    expect(hasUnsavedEnhancement(useSession.getState())).toBe(true);
    s.markSaved({ enhancedMode: 'enhance' });
    expect(hasUnsavedEnhancement(useSession.getState())).toBe(false);
  });
});
