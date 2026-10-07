export const colors = {
  background: '#000000',
  surface: 'rgba(28, 28, 30, 0.85)',
  surfaceSolid: '#1c1c1e',
  text: '#ffffff',
  textSecondary: 'rgba(235, 235, 245, 0.6)',
  accent: '#ffd60a',
  /** Zoom readout once past the optical range. */
  beyondOptical: '#64d2ff',
  /** Zoom readout past the native-pixel limit (AI-reconstructed). */
  reconstructed: '#ff9f0a',
  danger: '#ff453a',
  divider: 'rgba(255, 255, 255, 0.9)',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export function formatZoom(zoom: number): string {
  const rounded = zoom < 10 ? Math.round(zoom * 10) / 10 : Math.round(zoom);
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}x`;
}
