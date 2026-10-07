import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Camera, type CameraRef, useCameraPermission } from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { useZoomCamera } from '@/camera/useZoomCamera';
import { ModePicker } from '@/components/ModePicker';
import { PermissionScreen } from '@/components/PermissionScreen';
import { ZoomControls } from '@/components/ZoomControls';
import { useSession } from '@/state/session';
import { useSettings, useSettingsHydrated } from '@/state/settings';
import { colors, formatZoom, spacing } from '@/ui/theme';

export default function CameraScreen() {
  const permission = useCameraPermission();

  useEffect(() => {
    if (permission.canRequestPermission) permission.requestPermission();
    // Only on first mount; later changes come from AppState via the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!permission.hasPermission) {
    return permission.canRequestPermission ? (
      <PermissionScreen
        title="Camera access"
        message="superzoom needs the camera to take zoomed photos."
        onRequest={permission.requestPermission}
      />
    ) : (
      <PermissionScreen
        title="Camera access is off"
        message="superzoom needs the camera to take zoomed photos. Turn on camera access for superzoom in Settings."
      />
    );
  }
  return <ZoomCamera />;
}

function useCameraActive() {
  const [focused, setFocused] = useState(true);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return focused && appActive;
}

function ZoomCamera() {
  // Held in state (callback ref) so gesture callbacks never read a ref during render.
  const [camera, setCamera] = useState<CameraRef | null>(null);
  const [layout, setLayout] = useState({ width: 1, height: 2 });
  const longOverShort = Math.max(layout.width, layout.height) / Math.min(layout.width, layout.height);
  const zoomCamera = useZoomCamera(longOverShort);
  const { device, lensInfo, photoOutput, displayZoom, deviceZoom, previewScale, minDisplayZoom, maxDisplayZoom } =
    zoomCamera;
  const isActive = useCameraActive();
  const mode = useSettings((s) => s.mode);
  const setMode = useSettings((s) => s.setMode);
  const settingsHydrated = useSettingsHydrated();
  const [capturing, setCapturing] = useState(false);

  // Return at the zoom level the last photo was taken at (specs/enhanced-photo-review: Return to camera).
  useFocusEffect(
    useCallback(() => {
      const { captureZoom, original } = useSession.getState();
      if (original) displayZoom.set(captureZoom);
    }, [displayZoom]),
  );

  // Keep the zoom inside the range if the maximum shrinks after learning the real photo size.
  useEffect(() => {
    if (displayZoom.get() > maxDisplayZoom) displayZoom.set(maxDisplayZoom);
  }, [displayZoom, maxDisplayZoom]);

  const focusPoint = useSharedValue({ x: 0, y: 0 });
  const focusOpacity = useSharedValue(0);
  const flashOpacity = useSharedValue(0);

  const focusAt = useCallback(
    (x: number, y: number) => {
      camera?.focusTo({ x, y }).catch(() => {
        // Some lenses don't support focus metering; ignore.
      });
    },
    [camera],
  );

  const pinchStart = useSharedValue(1);
  const pinch = Gesture.Pinch()
    .onStart(() => {
      pinchStart.set(displayZoom.get());
    })
    .onUpdate((e) => {
      displayZoom.set(Math.min(maxDisplayZoom, Math.max(minDisplayZoom, pinchStart.get() * e.scale)));
    });

  const tap = Gesture.Tap().onEnd((e, success) => {
    if (!success) return;
    // Map the tap through the preview's digital scale back to the unscaled camera view.
    const cx = layout.width / 2;
    const cy = layout.height / 2;
    const s = previewScale.get();
    scheduleOnRN(focusAt, cx + (e.x - cx) / s, cy + (e.y - cy) / s);
    focusPoint.set({ x: e.x, y: e.y });
    focusOpacity.set(withSequence(withTiming(1, { duration: 80 }), withTiming(0, { duration: 900 })));
  });

  const previewStyle = useAnimatedStyle(() => ({ transform: [{ scale: previewScale.get() }] }));
  const focusStyle = useAnimatedStyle(() => ({
    opacity: focusOpacity.get(),
    left: focusPoint.get().x - 35,
    top: focusPoint.get().y - 35,
  }));
  const flashStyle = useAnimatedStyle(() => ({ opacity: flashOpacity.get() }));

  const onShutter = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    flashOpacity.set(withSequence(withTiming(0.8, { duration: 50 }), withTiming(0, { duration: 250 })));
    try {
      const result = await zoomCamera.capture();
      if (!result) return;
      const proceed = () => {
        useSession.getState().startSession(result.original, result.upload, result.displayZoom);
        router.push('/result');
      };
      if (result.framingClamped) {
        // The real photo was smaller than estimated: keep the preview honest from now on.
        displayZoom.set(withTiming(result.maxDisplayZoom));
        Alert.alert(
          'Zoom limited',
          `This lens supports up to ${formatZoom(result.maxDisplayZoom)}. The photo was taken at that zoom instead.`,
          [{ text: 'OK', onPress: proceed }],
        );
        return;
      }
      proceed();
    } catch (err) {
      Alert.alert('Capture failed', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setCapturing(false);
    }
  }, [capturing, displayZoom, flashOpacity, zoomCamera]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setLayout({ width, height });
  };

  if (!device || !lensInfo) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Starting camera…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <GestureDetector gesture={Gesture.Simultaneous(pinch, tap)}>
        <View style={StyleSheet.absoluteFill} onLayout={onLayout} collapsable={false}>
          <Animated.View style={[StyleSheet.absoluteFill, previewStyle]}>
            <Camera
              ref={setCamera}
              style={StyleSheet.absoluteFill}
              device={device}
              isActive={isActive}
              outputs={[photoOutput]}
              zoom={deviceZoom as SharedValue<number>}
              resizeMode="cover"
            />
          </Animated.View>
          <Animated.View pointerEvents="none" style={[styles.focusRing, focusStyle]} />
        </View>
      </GestureDetector>
      <Animated.View pointerEvents="none" style={[styles.flash, flashStyle]} />

      <SafeAreaView style={styles.overlay} pointerEvents="box-none" edges={['bottom']}>
        <ZoomControls displayZoom={displayZoom} lensInfo={lensInfo} maxZoom={maxDisplayZoom} />
        {/* Disabled until saved settings load, so a choice made now isn't overwritten by hydration. */}
        <ModePicker value={mode} onChange={setMode} disabled={!settingsHydrated} />
        <Pressable
          onPress={onShutter}
          disabled={capturing}
          accessibilityRole="button"
          accessibilityLabel="Take photo"
          accessibilityState={{ disabled: capturing }}
          style={({ pressed }) => [styles.shutter, (pressed || capturing) && styles.shutterPressed]}
        >
          <View style={styles.shutterInner} />
        </Pressable>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, overflow: 'hidden' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  muted: { color: colors.textSecondary },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    gap: spacing.lg,
    paddingBottom: spacing.lg,
  },
  focusRing: {
    position: 'absolute',
    width: 70,
    height: 70,
    borderWidth: 1.5,
    borderColor: colors.accent,
  },
  flash: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#000' },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterPressed: { opacity: 0.6, transform: [{ scale: 0.94 }] },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.text },
});
