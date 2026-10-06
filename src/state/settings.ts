import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { DEFAULT_MODE, type EnhanceMode, isEnhanceMode } from '@/shared/enhance';

export type CloudConsent = 'unknown' | 'granted' | 'declined';

interface SettingsState {
  mode: EnhanceMode;
  cloudConsent: CloudConsent;
  setMode(mode: EnhanceMode): void;
  setCloudConsent(consent: CloudConsent): void;
}

export const SETTINGS_STORAGE_KEY = 'superzoom.settings';

/** Mode choice and cloud consent, persisted across launches. */
export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      mode: DEFAULT_MODE,
      cloudConsent: 'unknown',
      setMode: (mode) => set({ mode }),
      setCloudConsent: (cloudConsent) => set({ cloudConsent }),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ mode, cloudConsent }) => ({ mode, cloudConsent }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          mode: isEnhanceMode(saved.mode) ? saved.mode : current.mode,
          cloudConsent:
            saved.cloudConsent === 'granted' || saved.cloudConsent === 'declined' ? saved.cloudConsent : 'unknown',
        };
      },
    },
  ),
);

const INSTALL_ID_KEY = 'superzoom.installId';
let installIdPromise: Promise<string> | undefined;

/** A random ID created on first launch and kept in secure storage (design.md decision 8). */
export function getInstallId(): Promise<string> {
  installIdPromise ??= (async () => {
    const existing = await SecureStore.getItemAsync(INSTALL_ID_KEY);
    if (existing) return existing;
    const id = Crypto.randomUUID();
    await SecureStore.setItemAsync(INSTALL_ID_KEY, id);
    return id;
  })().catch((err) => {
    installIdPromise = undefined;
    throw err;
  });
  return installIdPromise;
}

/** Test hook: forget the cached ID. */
export function resetInstallIdCache() {
  installIdPromise = undefined;
}
