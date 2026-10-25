// Silhouettes for the map's unit counters: soldiers, tanks, artillery, warships and aircraft.
// Each glyph is drawn in its own box (viewBox numbers below) and scaled into place.

export type Glyph = 'infantry' | 'armored' | 'mechanized' | 'artillery' | 'recon' | 'engineers' | 'warship' | 'carrier' | 'transport' | 'submarine' | 'fighter' | 'bomber';

/** [width, height, paths] — paths are filled with the glyph colour. */
const G: Record<Glyph, [number, number, string[]]> = {
  // a soldier with a rifle
  infantry: [24, 24, [
    'M10.6 1.6a2.8 2.8 0 1 1 0 5.6a2.8 2.8 0 1 1 0-5.6Z',
    'M6.8 8.4h7.6l1.4 6.4h-2.4l-0.7 7.4h-2.2l-0.5-5h-0.4l-0.5 5H7l-0.7-7.4H3.9Z',
    'M4.2 16.6 19.2 2.4l1.5 1.6-15 14.2Z',
  ]],
  // main battle tank, side view
  armored: [26, 16, [
    'M3.5 8.4 6 5.6h14.6l2.4 2.8Z',
    'M8.6 5.6 9.4 2.8q0.3-0.8 1.2-0.8h4.8q0.9 0 1.2 0.8l0.7 2.8Z',
    'M16.6 3.1h8.6v1.4h-8.6Z',
    'M2.4 9.2h21.2q1.9 0 1.9 2.1 0 2.4-2.3 2.4H2.8q-2.3 0-2.3-2.4 0-2.1 1.9-2.1Zm2.1 2.1a1.1 1.1 0 1 0 0 0.1Zm4.2 0a1.1 1.1 0 1 0 0 0.1Zm4.2 0a1.1 1.1 0 1 0 0 0.1Zm4.2 0a1.1 1.1 0 1 0 0 0.1Zm4.2 0a1.1 1.1 0 1 0 0 0.1Z',
  ]],
  // armoured personnel carrier on wheels
  mechanized: [26, 16, [
    'M1.5 11.2 4 5.4h15.6l4.6 3.6v2.2Z',
    'M8.5 3.2h4.6v2.2H8.5Z M13.1 3.9h4.4v0.9h-4.4Z',
    'M6 11.4a2.1 2.1 0 1 1 0 4.2a2.1 2.1 0 1 1 0-4.2Zm6.4 0a2.1 2.1 0 1 1 0 4.2a2.1 2.1 0 1 1 0-4.2Zm6.4 0a2.1 2.1 0 1 1 0 4.2a2.1 2.1 0 1 1 0-4.2Z',
  ]],
  // field gun on wheels
  artillery: [24, 20, [
    'M3.2 12.8 20.4 1.6l1.8 2.6L5 15.4Z',
    'M5.6 8.6h6.2l1 4.6H6.6Z',
    'M9 10.2a4.8 4.8 0 1 1 0 9.6a4.8 4.8 0 1 1 0-9.6Zm0 2.8a2 2 0 1 0 0 4a2 2 0 1 0 0-4Z',
    'M9.6 15.6 1.4 19.8 0.4 18l8.2-4.2Z',
  ]],
  // binoculars
  recon: [24, 18, [
    'M2.4 7.2Q3 4.2 6 4.2h1.6V2.2h3.2v5h2.4v-5h3.2v2h1.6q3 0 3.6 3l1.1 5.3a4.6 4.6 0 0 1-4.5 5.6 4.6 4.6 0 0 1-4.6-4.6V11.4h-2.4v2.1a4.6 4.6 0 0 1-4.6 4.6A4.6 4.6 0 0 1 1.3 12.5Z',
  ]],
  // bridge
  engineers: [24, 18, [
    'M1 7.4h22v2.6H1Z',
    'M3 10h2.6v7H3Zm15.4 0H21v7h-2.6Z',
    'M5.6 10q6.4 5.4 12.8 0v2.4q-6.4 4.6-12.8 0Z',
  ]],
  // destroyer / cruiser, side view
  warship: [30, 14, [
    'M0.6 7.4h28.8l-3.2 5.4H4.4Z',
    'M9 7.4V4.2h6.4v3.2Zm6.4 0V5.2h4.4v2.2Z',
    'M11.8 4.2V0.8h0.9v3.4Z',
    'M19.6 5.6h6.2v1.1h-6.2Z M3.2 6.2h4.4v1.2H3.2Z',
  ]],
  // aircraft carrier
  carrier: [32, 14, [
    'M0.4 6.6h31.2v1.4l-3.4 4.8H4.6L0.4 8Z',
    'M21 6.6V2.6h3.6v4Z',
    'M5 6h3.8v0.6H5Zm6 0h3.8v0.6H11Z',
  ]],
  // troop transport
  transport: [30, 14, [
    'M0.8 7.6h28.4l-3 5.2H4.2Z',
    'M5 7.6V3.6h4.8v4Zm5.4 0V3.6h4.8v4Zm5.4 0V3.6H21v4Z',
    'M23.4 7.6V2.4h3v5.2Z',
  ]],
  // submarine running on the surface: long hull, conning tower, periscope
  submarine: [30, 12, [
    'M1 8.2Q1 5.8 4.4 5.8h21.2q3.4 0 3.4 2.4 0 2.4-3.4 2.4H4.4Q1 10.6 1 8.2Z',
    'M11.4 5.8 12.4 2.6h5.2l0.8 3.2Z',
    'M15.6 2.6V0.4h0.9v2.2Z',
    'M27.2 6.8 29.6 5.2v6l-2.4-1.6Z',
  ]],
  // fighter jet, top view
  fighter: [24, 24, [
    'M12 0.8 13.3 4.6V9l9 4.6v1.6L13.3 13l-0.2 5.6 3 2.2v1.3L12 21.2l-4.1 0.9v-1.3l3-2.2-0.2-5.6-9 2.2v-1.6l9-4.6V4.6Z',
  ]],
  // bomber, top view (long straight wings)
  bomber: [26, 24, [
    'M13 1.2 14.2 5V9.4l10.6 3v1.8l-10.6-1.4-0.2 6.4 3.2 2v1.4L13 21.6l-4.2 1v-1.4l3.2-2-0.2-6.4-10.6 1.4v-1.8l10.6-3V5Z',
    'M6.6 11.2h1.6v1.6H6.6Zm11.2 0h1.6v1.6h-1.6Z',
  ]],
};

/** Draw a glyph centred at (cx, cy), `h` map units tall. */
export function GlyphShape({ g, cx, cy, h, fill = '#fff', opacity = 1 }: { g: Glyph; cx: number; cy: number; h: number; fill?: string; opacity?: number }) {
  const [w, gh, paths] = G[g];
  const s = h / gh;
  return (
    <g transform={`translate(${cx - (w * s) / 2},${cy - h / 2}) scale(${s})`} fill={fill} opacity={opacity} fillRule="evenodd">
      {paths.map((d, i) => <path key={i} d={d} />)}
    </g>
  );
}
export const glyphAspect = (g: Glyph) => G[g][0] / G[g][1];
