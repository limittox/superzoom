import { router, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CompareView } from '@/components/CompareView';
import { ConsentSheet } from '@/components/ConsentSheet';
import { ModePicker } from '@/components/ModePicker';
import { MODE_LABELS, RETRYABLE } from '@/enhance/messages';
import { enhancementRunner } from '@/enhance/runner';
import { saveToGallery } from '@/media/saveToGallery';
import type { EnhanceMode } from '@/shared/enhance';
import { hasUnsavedEnhancement, useSession } from '@/state/session';
import { useSettings, useSettingsHydrated } from '@/state/settings';
import { colors, spacing } from '@/ui/theme';

export default function ResultScreen() {
  const navigation = useNavigation();
  const original = useSession((s) => s.original);
  const results = useSession((s) => s.results);
  const shownMode = useSession((s) => s.shownMode);
  const request = useSession((s) => s.request);
  const { cloudConsent, setCloudConsent, mode: preferredMode, setMode } = useSettings();
  // Saved consent loads asynchronously; nothing below may act on `cloudConsent` until it has.
  const hydrated = useSettingsHydrated();
  const [consentRequested, setConsentRequested] = useState(false);
  const [consentAnswered, setConsentAnswered] = useState(false);
  // First capture without a consent decision: ask before uploading anything.
  const consentVisible =
    consentRequested || (hydrated && !!original && cloudConsent === 'unknown' && !consentAnswered);
  const [saving, setSaving] = useState(false);
  const started = useRef(false);

  const enhanced = shownMode ? results[shownMode] : undefined;
  const selectedMode: EnhanceMode =
    request.status === 'pending' || request.status === 'error' ? request.mode : (shownMode ?? preferredMode);

  const enhance = useCallback(
    (mode: EnhanceMode) => {
      if (useSettings.getState().cloudConsent !== 'granted') {
        setConsentRequested(true);
        return;
      }
      enhancementRunner.start(mode);
    },
    [],
  );

  // Start automatically after capture (specs/enhanced-photo-review: Automatic enhancement after capture).
  useEffect(() => {
    if (!hydrated || started.current || !original) return;
    started.current = true;
    if (cloudConsent === 'granted') enhancementRunner.start(preferredMode);
  }, [cloudConsent, hydrated, original, preferredMode]);

  // Confirm before discarding an unsaved enhancement (specs/enhanced-photo-review: Return to camera).
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e) => {
        const state = useSession.getState();
        if (!hasUnsavedEnhancement(state)) {
          enhancementRunner.cancel();
          return;
        }
        e.preventDefault();
        Alert.alert('Discard enhanced photo?', "You haven't saved the enhanced image.", [
          { text: 'Keep editing', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => {
              enhancementRunner.cancel();
              navigation.dispatch(e.data.action);
            },
          },
        ]);
      }),
    [navigation],
  );

  const onSelectMode = (mode: EnhanceMode) => {
    setMode(mode);
    if (results[mode]) {
      useSession.getState().showMode(mode);
      if (request.status === 'pending') enhancementRunner.cancel();
    } else {
      enhance(mode);
    }
  };

  const onConsent = (granted: boolean) => {
    setConsentRequested(false);
    setConsentAnswered(true);
    setCloudConsent(granted ? 'granted' : 'declined');
    if (granted) enhancementRunner.start(selectedMode);
  };

  const save = async (which: 'enhanced' | 'original' | 'both') => {
    if (!original) return;
    const { saved: alreadySaved, markSaved } = useSession.getState();
    // Skip files already in the library so a retry after a partial save doesn't duplicate them.
    const wanted: { uri: string; kind: 'enhanced' | 'original' }[] = [];
    if (which !== 'original' && enhanced && shownMode && !alreadySaved.enhanced[shownMode]) {
      wanted.push({ uri: enhanced.uri, kind: 'enhanced' });
    }
    if (which !== 'enhanced' && !alreadySaved.original) wanted.push({ uri: original.uri, kind: 'original' });
    if (wanted.length === 0) {
      Alert.alert('Already saved', 'This photo is already in your library.');
      return;
    }

    setSaving(true);
    const { outcome, saved } = await saveToGallery(wanted.map((w) => w.uri));
    setSaving(false);
    for (const item of wanted) {
      if (!saved.includes(item.uri)) continue;
      markSaved(item.kind === 'original' ? { original: true } : { enhancedMode: shownMode ?? undefined });
    }

    if (outcome === 'saved') {
      Alert.alert('Saved', wanted.length > 1 ? 'Both photos were saved to your library.' : 'Saved to your library.');
    } else if (outcome === 'partial') {
      const savedKind = wanted.find((w) => saved.includes(w.uri))?.kind;
      Alert.alert(
        'Partly saved',
        `The ${savedKind} photo was saved, but the other one couldn't be. Tap Save to try again.`,
      );
    } else if (outcome === 'denied') {
      Alert.alert('Photos access needed', 'Allow superzoom to add photos in Settings to save your images.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ]);
    } else {
      Alert.alert('Save failed', 'The photo could not be saved. Please try again.');
    }
  };

  const showSaveOptions = () => {
    if (!enhanced) return save('original');
    Alert.alert('Save to Photos', undefined, [
      { text: 'Enhanced', onPress: () => save('enhanced') },
      { text: 'Original', onPress: () => save('original') },
      { text: 'Both', onPress: () => save('both') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  if (!original) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.muted}>No photo.</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.link}>Back to camera</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={12}>
          <Text style={styles.link}>‹ Camera</Text>
        </Pressable>
        {enhanced && shownMode && (
          <View style={styles.label} accessibilityRole="text">
            <Text style={styles.labelText}>AI-enhanced ({MODE_LABELS[shownMode].title})</Text>
          </View>
        )}
        <Pressable onPress={showSaveOptions} disabled={saving} accessibilityRole="button" hitSlop={12}>
          <Text style={[styles.link, saving && styles.disabled]}>Save</Text>
        </Pressable>
      </View>

      <View style={styles.viewer}>
        <CompareView original={original} enhanced={enhanced} />
        {enhanced && (
          <View style={styles.sideLabels} pointerEvents="none">
            <Text style={styles.sideLabel}>Original</Text>
            <Text style={styles.sideLabel}>Enhanced</Text>
          </View>
        )}
        {request.status === 'pending' && (
          <View style={styles.status}>
            <ActivityIndicator color={colors.text} />
            <Text style={styles.statusText}>Enhancing with {MODE_LABELS[request.mode].title}…</Text>
            <Pressable onPress={() => enhancementRunner.cancel()} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
          </View>
        )}
        {request.status === 'error' && (
          <View style={styles.status}>
            <Text style={styles.statusText}>{request.error.message}</Text>
            {RETRYABLE.has(request.error.code) && (
              <Pressable onPress={() => enhance(request.mode)} accessibilityRole="button" hitSlop={8}>
                <Text style={styles.link}>Retry</Text>
              </Pressable>
            )}
          </View>
        )}
        {cloudConsent === 'declined' && !enhanced && request.status === 'idle' && (
          <View style={styles.status}>
            <Text style={styles.statusText}>Cloud enhancement is off.</Text>
            <Pressable onPress={() => setConsentRequested(true)} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.link}>Enhance</Text>
            </Pressable>
          </View>
        )}
      </View>

      {shownMode === 'creative' && enhanced && (
        <Text style={styles.caveat}>Creative mode may invent detail that doesn&apos;t match reality.</Text>
      )}
      <View style={styles.footer}>
        <ModePicker value={selectedMode} onChange={onSelectMode} completed={results} />
      </View>

      <ConsentSheet visible={consentVisible} onAccept={() => onConsent(true)} onDecline={() => onConsent(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, backgroundColor: colors.background },
  muted: { color: colors.textSecondary },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  link: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  label: { backgroundColor: colors.surface, borderRadius: 999, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  labelText: { color: colors.beyondOptical, fontSize: 13, fontWeight: '700' },
  viewer: { flex: 1 },
  sideLabels: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sideLabel: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  status: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: 14,
    backgroundColor: colors.surface,
  },
  statusText: { flex: 1, color: colors.text, fontSize: 14 },
  caveat: { color: colors.textSecondary, fontSize: 12, textAlign: 'center', paddingHorizontal: spacing.lg },
  footer: { paddingVertical: spacing.lg },
});
