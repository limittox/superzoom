import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '@/ui/theme';

interface Props {
  enabled: boolean;
  running: boolean;
  onToggle(): void;
  onBurst(): void;
  nightRunning: boolean;
  onNight(): void;
}

/**
 * Development builds only: the capture experiments. Turns on the burst lab (adds a 4K frame stream)
 * and takes a burst, or takes a Night extension A/B pair.
 */
export function DevLabBar({ enabled, running, onToggle, onBurst, nightRunning, onNight }: Props) {
  const busy = running || nightRunning;
  return (
    <View style={styles.bar}>
      <Pressable onPress={onNight} disabled={busy} accessibilityRole="button" hitSlop={8}>
        <Text style={[styles.label, styles.action, busy && styles.busy]}>
          {nightRunning ? 'Night…' : 'Night A/B'}
        </Text>
      </Pressable>
      <Pressable onPress={onToggle} accessibilityRole="switch" accessibilityState={{ checked: enabled }} hitSlop={8}>
        <Text style={[styles.label, enabled && styles.on]}>Burst lab {enabled ? 'on' : 'off'}</Text>
      </Pressable>
      {enabled && (
        <Pressable onPress={onBurst} disabled={busy} accessibilityRole="button" hitSlop={8}>
          <Text style={[styles.label, styles.action, running && styles.busy]}>
            {running ? 'Capturing…' : 'Take burst'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    gap: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  label: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  on: { color: colors.accent },
  action: { color: colors.text },
  busy: { opacity: 0.6 },
});
