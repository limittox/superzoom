import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MODE_LABELS } from '@/enhance/messages';
import { ENHANCE_MODES, type EnhanceMode } from '@/shared/enhance';
import { colors, spacing } from '@/ui/theme';

interface Props {
  value: EnhanceMode;
  onChange(mode: EnhanceMode): void;
  /** Modes that already have a result (shown with a dot). */
  completed?: Partial<Record<EnhanceMode, unknown>>;
  disabled?: boolean;
}

/** Enhance / Pro / Creative selector with a one-line description (specs/enhanced-photo-review: Mode selection). */
export function ModePicker({ value, onChange, completed, disabled }: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.row} accessibilityRole="radiogroup">
        {ENHANCE_MODES.map((mode) => {
          const selected = mode === value;
          return (
            <Pressable
              key={mode}
              onPress={() => onChange(mode)}
              disabled={disabled}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled }}
              style={[styles.chip, selected && styles.chipSelected]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                {MODE_LABELS[mode].title}
                {completed?.[mode] ? ' •' : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.description}>{MODE_LABELS[value].description}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', gap: spacing.xs },
  row: { flexDirection: 'row', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.accent },
  chipText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  chipTextSelected: { color: '#000' },
  description: { color: colors.textSecondary, fontSize: 13 },
});
