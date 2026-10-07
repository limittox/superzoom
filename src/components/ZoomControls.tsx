import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { type SharedValue, useAnimatedReaction, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { LensInfo } from '@/camera/lenses';
import { colors, formatZoom, spacing } from '@/ui/theme';

const BEYOND_PRESETS = [10, 20, 30, 50, 100];

/** One preset per physical lens plus beyond-optical presets up to the maximum (specs/zoom-capture: Zoom presets). */
export function zoomPresets(lensInfo: LensInfo, maxZoom: number): number[] {
  const lensPresets = [...new Set(lensInfo.lenses.map((l) => l.displayZoom))];
  const cap = lensInfo.opticalCapDisplay;
  let beyond = BEYOND_PRESETS.filter((p) => p > cap * 1.5 && p <= maxZoom).slice(0, 2);
  if (beyond.length === 0 && maxZoom > cap * 1.2) beyond = [Math.floor(maxZoom)];
  return [...lensPresets, ...beyond];
}

interface Props {
  displayZoom: SharedValue<number>;
  lensInfo: LensInfo;
  maxZoom: number;
}

export function ZoomControls({ displayZoom, lensInfo, maxZoom }: Props) {
  // Mirror the UI-thread zoom into React state at 0.1x resolution for the label.
  const [zoom, setZoom] = useState(1);
  useAnimatedReaction(
    () => Math.round(displayZoom.get() * 10) / 10,
    (current, previous) => {
      if (current !== previous) scheduleOnRN(setZoom, current);
    },
  );

  const cap = lensInfo.opticalCapDisplay;
  const beyondOptical = zoom > cap + 0.05;
  const presets = zoomPresets(lensInfo, maxZoom);

  return (
    <View style={styles.container} pointerEvents="box-none">
      <View
        style={[styles.readout, beyondOptical && styles.readoutBeyond]}
        accessibilityLabel={`Zoom ${formatZoom(zoom)}${beyondOptical ? ', beyond optical range, AI enhanced' : ''}`}
      >
        <Text style={[styles.readoutText, beyondOptical && styles.readoutTextBeyond]}>{formatZoom(zoom)}</Text>
        {beyondOptical && <Text style={styles.badge}>AI ZOOM</Text>}
      </View>
      <View style={styles.presets}>
        {presets.map((preset) => {
          const active = Math.abs(zoom - preset) / preset < 0.05;
          return (
            <Pressable
              key={preset}
              onPress={() => {
                displayZoom.set(withTiming(preset, { duration: 300 }));
              }}
              accessibilityRole="button"
              accessibilityLabel={`Zoom to ${formatZoom(preset)}`}
              style={[styles.preset, active && styles.presetActive, preset > cap && styles.presetBeyond]}
            >
              <Text style={[styles.presetText, active && styles.presetTextActive]}>{formatZoom(preset)}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', gap: spacing.md },
  readout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 999,
    backgroundColor: colors.surface,
  },
  readoutBeyond: { borderWidth: 1, borderColor: colors.beyondOptical },
  readoutText: { color: colors.accent, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  readoutTextBeyond: { color: colors.beyondOptical },
  badge: { color: colors.beyondOptical, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  presets: {
    flexDirection: 'row',
    gap: spacing.xs,
    padding: spacing.xs,
    borderRadius: 999,
    backgroundColor: colors.surface,
  },
  preset: { minWidth: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  presetActive: { backgroundColor: 'rgba(255,255,255,0.15)' },
  presetBeyond: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.beyondOptical },
  presetText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  presetTextActive: { color: colors.accent },
});
