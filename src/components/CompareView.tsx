import { Image } from 'expo-image';
import { useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import type { LocalImage } from '@/state/session';
import { colors } from '@/ui/theme';

const MAX_SCALE = 8;
const HANDLE_HIT = 44;

interface Props {
  original: LocalImage;
  /** When absent, only the original is shown. */
  enhanced?: LocalImage;
}

/**
 * Before/after comparison: original on the left of the divider, enhanced on the right.
 * Both images share one pinch/pan transform so they stay aligned
 * (specs/enhanced-photo-review: Before/after comparison).
 */
export function CompareView({ original, enhanced }: Props) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const divider = useSharedValue(0.5); // fraction of width
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const start = useSharedValue({ scale: 1, tx: 0, ty: 0, divider: 0.5 });

  const clampTranslation = (value: number, extent: number, s: number) => {
    'worklet';
    const max = (extent * (s - 1)) / 2;
    return Math.min(max, Math.max(-max, value));
  };

  const pinch = Gesture.Pinch()
    .onStart(() => {
      start.set({ ...start.get(), scale: scale.get() });
    })
    .onUpdate((e) => {
      scale.set(Math.min(MAX_SCALE, Math.max(1, start.get().scale * e.scale)));
      tx.set(clampTranslation(tx.get(), size.width, scale.get()));
      ty.set(clampTranslation(ty.get(), size.height, scale.get()));
    });

  const pan = Gesture.Pan()
    .minPointers(1)
    .onStart(() => {
      start.set({ ...start.get(), tx: tx.get(), ty: ty.get() });
    })
    .onUpdate((e) => {
      tx.set(clampTranslation(start.get().tx + e.translationX, size.width, scale.get()));
      ty.set(clampTranslation(start.get().ty + e.translationY, size.height, scale.get()));
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scale.set(withTiming(1));
      tx.set(withTiming(0));
      ty.set(withTiming(0));
    });

  const dividerPan = Gesture.Pan()
    .onStart(() => {
      start.set({ ...start.get(), divider: divider.get() });
    })
    .onUpdate((e) => {
      if (size.width === 0) return;
      divider.set(Math.min(1, Math.max(0, start.get().divider + e.translationX / size.width)));
    });

  const imageTransform = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.get() }, { translateY: ty.get() }, { scale: scale.get() }],
  }));
  // The enhanced layer is clipped in screen space to the right of the divider, then
  // shifted back so its image lines up with the original underneath.
  const clipStyle = useAnimatedStyle(() => ({ left: divider.get() * size.width }));
  const unclipStyle = useAnimatedStyle(() => ({ left: -divider.get() * size.width }));
  const handleStyle = useAnimatedStyle(() => ({ left: divider.get() * size.width - HANDLE_HIT / 2 }));

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ width, height });
  };

  return (
    <View style={styles.container} onLayout={onLayout}>
      <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          <Animated.View style={[StyleSheet.absoluteFill, imageTransform]}>
            <Image source={{ uri: original.uri }} style={StyleSheet.absoluteFill} contentFit="contain" />
          </Animated.View>
          {enhanced && (
            <Animated.View style={[styles.clip, clipStyle]} pointerEvents="none">
              <Animated.View style={[styles.unclip, { width: size.width }, unclipStyle]}>
                <Animated.View style={[StyleSheet.absoluteFill, imageTransform]}>
                  <Image source={{ uri: enhanced.uri }} style={StyleSheet.absoluteFill} contentFit="contain" />
                </Animated.View>
              </Animated.View>
            </Animated.View>
          )}
        </View>
      </GestureDetector>
      {enhanced && (
        <GestureDetector gesture={dividerPan}>
          <Animated.View
            style={[styles.handleHit, handleStyle]}
            accessibilityRole="adjustable"
            accessibilityLabel="Comparison divider. Original on the left, enhanced on the right."
          >
            <View style={styles.handleLine} />
            <View style={styles.handleKnob} />
          </Animated.View>
        </GestureDetector>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden', backgroundColor: colors.background },
  clip: { position: 'absolute', top: 0, bottom: 0, right: 0, overflow: 'hidden' },
  unclip: { position: 'absolute', top: 0, bottom: 0 },
  handleHit: { position: 'absolute', top: 0, bottom: 0, width: HANDLE_HIT, alignItems: 'center', justifyContent: 'center' },
  handleLine: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: colors.divider },
  handleKnob: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.divider,
    borderWidth: 2,
    borderColor: colors.background,
  },
});
