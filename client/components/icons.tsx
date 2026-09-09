import type { SVGProps } from 'react';

/* One icon system for the whole console (call-card v2 polish). Lucide idiom: 24 grid, 1.75 stroke,
 * round caps/joins, currentColor, no fill unless the mark needs it (Play, LinkedIn). Sized in em so an
 * icon inherits the text size beside it; override with width/height or a class. Consistency is the point
 * — one geometry everywhere reads as a designed product, ad-hoc glyphs read as a prototype. */
type P = SVGProps<SVGSVGElement> & { size?: number };
const Svg = ({ size, children, ...p }: P & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width={size ?? '1em'} height={size ?? '1em'} fill="none" stroke="currentColor"
    strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" {...p}>{children}</svg>
);

export const Phone = (p: P) => <Svg {...p}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.1 9.9a16 16 0 0 0 6 6l1.26-1.26a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" /></Svg>;
export const PhoneOff = (p: P) => <Svg {...p}><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.4 19.4 0 0 1-3.33-2.67m-2.67-3.34A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.1 9.9" /><path d="M2 2 22 22" /></Svg>;
export const Mic = (p: P) => <Svg {...p}><rect x="9" y="2" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></Svg>;
export const MicOff = (p: P) => <Svg {...p}><path d="M9 5a3 3 0 0 1 6 0v5m-1.7 3.28A3 3 0 0 1 9 11" /><path d="M5 11a7 7 0 0 0 10.5 6.05M19 11v-.5M12 18v3" /><path d="M2 2 22 22" /></Svg>;
export const Keypad = (p: P) => <Svg {...p} fill="currentColor" stroke="none">{[6, 12, 18].flatMap((y) => [6, 12, 18].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" />))}</Svg>;
export const Delete = (p: P) => <Svg {...p}><path d="M20 5H9l-6 7 6 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" /><path d="m17 9-6 6M11 9l6 6" /></Svg>;
export const User = (p: P) => <Svg {...p}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Svg>;
export const Building = (p: P) => <Svg {...p}><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M10 21v-3a2 2 0 0 1 4 0v3" /></Svg>;
export const Briefcase = (p: P) => <Svg {...p}><rect x="2.5" y="7" width="19" height="13" rx="2" /><path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7M2.5 12.5h19" /></Svg>;
export const Mail = (p: P) => <Svg {...p}><rect x="2.5" y="4.5" width="19" height="15" rx="2" /><path d="m3 6 9 6 9-6" /></Svg>;
export const LinkedIn = (p: P) => <Svg {...p} fill="currentColor" stroke="none"><path d="M4.98 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM3.2 9.25h3.56V21H3.2zM9.4 9.25h3.41v1.6h.05c.47-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46V21h-3.56v-5.24c0-1.25-.02-2.86-1.74-2.86-1.75 0-2.01 1.36-2.01 2.77V21H9.4z" /></Svg>;
export const External = (p: P) => <Svg {...p}><path d="M15 3h6v6M21 3l-9 9M20 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5" /></Svg>;
export const Clock = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
export const History = (p: P) => <Svg {...p}><path d="M3.5 9A9 9 0 1 1 3 13.5" /><path d="M3 4v5h5M12 8v4.5l3 1.8" /></Svg>;
export const Calendar = (p: P) => <Svg {...p}><rect x="3" y="4.5" width="18" height="16.5" rx="2" /><path d="M8 2.5v4M16 2.5v4M3 9.5h18" /></Svg>;
export const Check = (p: P) => <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>;
export const X = (p: P) => <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>;
export const Ban = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></Svg>;
export const ThumbsUp = (p: P) => <Svg {...p}><path d="M7 22V11M2 13v7a2 2 0 0 0 2 2h13.5a2 2 0 0 0 1.98-1.7l1.3-8.5A2 2 0 0 0 19.8 9.5H14V6a2.5 2.5 0 0 0-2.5-2.5L7 11" /></Svg>;
export const ThumbsDown = (p: P) => <Svg {...p}><path d="M17 2v11M22 11V4a2 2 0 0 0-2-2H6.5a2 2 0 0 0-1.98 1.7l-1.3 8.5A2 2 0 0 0 5.2 14.5H10v3a2.5 2.5 0 0 0 2.5 2.5L17 13" /></Svg>;
export const ChevronDown = (p: P) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
export const ChevronRight = (p: P) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>;
export const Plus = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const ArrowRight = (p: P) => <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;
export const Play = (p: P) => <Svg {...p} fill="currentColor" stroke="none"><path d="M7 5.3v13.4a1 1 0 0 0 1.54.84l10.3-6.7a1 1 0 0 0 0-1.68L8.54 4.46A1 1 0 0 0 7 5.3z" /></Svg>;
export const Upload = (p: P) => <Svg {...p}><path d="M12 15V3m-5 5 5-5 5 5M20 17v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2" /></Svg>;
export const LogOut = (p: P) => <Svg {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></Svg>;
export const List = (p: P) => <Svg {...p}><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></Svg>;
export const Layers = (p: P) => <Svg {...p}><path d="m12 2 9 5-9 5-9-5 9-5z" /><path d="m3 12 9 5 9-5M3 17l9 5 9-5" /></Svg>;
export const Tag = (p: P) => <Svg {...p}><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2 2 0 0 0 2.83 0l6.57-6.57a2 2 0 0 0 0-2.83z" /><circle cx="7" cy="7" r="1.3" fill="currentColor" stroke="none" /></Svg>;
export const MapPin = (p: P) => <Svg {...p}><path d="M20 10c0 5.5-8 12-8 12s-8-6.5-8-12a8 8 0 0 1 16 0z" /><circle cx="12" cy="10" r="2.6" /></Svg>;
export const Activity = (p: P) => <Svg {...p}><path d="M22 12h-3.5l-2.5 7-5-16-2.5 9H3" /></Svg>;
export const Dialpad = Keypad;
