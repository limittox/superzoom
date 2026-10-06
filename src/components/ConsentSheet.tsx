import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '@/ui/theme';

interface Props {
  visible: boolean;
  onAccept(): void;
  onDecline(): void;
}

/** Shown before the first upload (specs/enhanced-photo-review: Cloud processing disclosure). */
export function ConsentSheet({ visible, onAccept, onDecline }: Props) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onDecline}>
      <View style={styles.backdrop}>
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <Text style={styles.title}>Enhance in the cloud?</Text>
          <Text style={styles.body}>
            To sharpen your zoomed photo, superzoom sends the cropped image to a cloud AI service (fal.ai) for
            processing. Photos are used only to create your enhanced image and are deleted from the service within an
            hour.
          </Text>
          <Text style={styles.body}>
            If you decline, nothing is uploaded. You can still view and save the original.
          </Text>
          <Pressable style={styles.primary} onPress={onAccept} accessibilityRole="button">
            <Text style={styles.primaryText}>Allow cloud enhancement</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={onDecline} accessibilityRole="button">
            <Text style={styles.secondaryText}>Not now</Text>
          </Pressable>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: colors.surfaceSolid,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.xl,
    gap: spacing.md,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  body: { color: colors.textSecondary, fontSize: 15, lineHeight: 21 },
  primary: {
    marginTop: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  primaryText: { color: '#000', fontSize: 16, fontWeight: '600' },
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryText: { color: colors.text, fontSize: 16 },
});
