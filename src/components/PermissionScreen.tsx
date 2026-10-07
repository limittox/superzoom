import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '@/ui/theme';

interface Props {
  title: string;
  message: string;
  /** Shown while the system prompt can still be displayed. */
  onRequest?: () => void;
}

/** Explains a missing permission and links to system settings (specs/zoom-capture: Camera permission). */
export function PermissionScreen({ title, message, onRequest }: Props) {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.message}>{message}</Text>
        {onRequest ? (
          <Pressable style={styles.button} onPress={onRequest} accessibilityRole="button">
            <Text style={styles.buttonText}>Allow access</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.button} onPress={() => Linking.openSettings()} accessibilityRole="button">
            <Text style={styles.buttonText}>Open Settings</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, justifyContent: 'center', padding: spacing.xxl, gap: spacing.lg },
  title: { color: colors.text, fontSize: 24, fontWeight: '700' },
  message: { color: colors.textSecondary, fontSize: 16, lineHeight: 22 },
  button: {
    marginTop: spacing.md,
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: 999,
  },
  buttonText: { color: '#000', fontSize: 16, fontWeight: '600' },
});
