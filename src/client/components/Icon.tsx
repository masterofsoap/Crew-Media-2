import type { SVGProps } from "react";

/** Original stroke icon set (24px grid). */
const P: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  explore: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm3.5-12.5-2 5-5 2 2-5z",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.5a6 6 0 0 1 3 5.5",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.5-2-3.4-2.3 1a7.5 7.5 0 0 0-2.3-1.3L14.4 3h-4l-.4 2.5a7.5 7.5 0 0 0-2.3 1.3l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.6l-2 1.5 2 3.4 2.3-1a7.5 7.5 0 0 0 2.3 1.3l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.3-1.3l2.3 1 2-3.4-2-1.5c.1-.4.1-.9.1-1.3Z",
  palette: "M12 3a9 9 0 0 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4-4-7.5-9-7.5ZM7.5 11.5h.01M10 7.5h.01M15 7.5h.01",
  briefcase: "M4 8h16v11H4zM9 8V5h6v3M4 13h16",
  shield: "M12 3 4.5 6v6c0 4.5 3.2 7.7 7.5 9 4.3-1.3 7.5-4.5 7.5-9V6z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 4.5 4.5",
  heart: "M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z",
  reply: "M20 15.5a2 2 0 0 1-2 2H9l-5 3.5V6.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z",
  repost: "M5 9V8a3 3 0 0 1 3-3h10l-3-3M19 15v1a3 3 0 0 1-3 3H6l3 3",
  quote: "M7 11h4v7H5v-5a6 6 0 0 1 4-5.6M15 11h4v7h-6v-5a6 6 0 0 1 4-5.6",
  share: "M12 3v12M7 8l5-5 5 5M5 14v5h14v-5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01",
  video: "M3 6h12v12H3zM15 10l6-3v10l-6-3",
  close: "M6 6l12 12M18 6 6 18",
  check: "M5 12.5 10 17 19 7",
  back: "M15 5 8 12l7 7",
  plus: "M12 5v14M5 12h14",
  send: "M4 12 20 4l-6 16-3-7z",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3Z",
  switch: "M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8",
  logout: "M10 5H5v14h5M14 8l4 4-4 4M18 12H9",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  undo: "M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2",
  redo: "M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h2",
  reset: "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  location: "M12 21s-6-5.5-6-11a6 6 0 1 1 12 0c0 5.5-6 11-6 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  pin: "M9 3h6l-1 6 3 3H7l3-3zM12 12v9",
  menu: "M4 7h16M4 12h16M4 17h16",
  mute: "M5 9h3l5-4v14l-5-4H5zM17 9l4 6M21 9l-4 6",
  block: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8",
  hash: "M5 9h15M4 15h15M10 4 8 20M16 4l-2 16",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  trophy: "M8 4h8v5a4 4 0 0 1-8 0zM8 6H4v2a3 3 0 0 0 4 3M16 6h4v2a3 3 0 0 1-4 3M12 13v4M8 20h8M9 17h6",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  phone: "M7 2h10v20H7zM11 18h2",
  layers: "M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 18l10 5 10-5",
  type: "M4 7V5h16v2M12 5v14M9 19h6",
  // Accent icons for profile customization
  spark: "M12 2v6M12 16v6M2 12h6M16 12h6M5 5l4 4M15 15l4 4M5 19l4-4M15 9l4-4",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  leaf: "M5 19c0-9 6-14 15-14 0 9-5 15-14 15M5 19l8-8",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  wave: "M2 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0M2 17c2-3 4-3 6 0s4 3 6 0 4-3 6 0",
  flame: "M12 22a7 7 0 0 0 7-7c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-3 3-5 5-5 8a7 7 0 0 0 7 7Z",
  crown: "M3 8l4 4 5-7 5 7 4-4-2 11H5zM5 19h14",
  music: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  camera: "M4 7h4l2-3h4l2 3h4v13H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  gamepad: "M6 8h12a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.6L14 15h-4l-1 .6A4 4 0 0 1 2 13v-1a4 4 0 0 1 4-4ZM7 11v3M5.5 12.5h3M16 12h.01M18 14h.01",
  book: "M4 4h7a3 3 0 0 1 3 3v14a2.5 2.5 0 0 0-2.5-2.5H4zM20 4h-6M20 4v14.5h-6",
  rocket: "M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 15l-3-3c1.5-4.5 5-9 12-9 0 7-4.5 10.5-9 12ZM15 9h.01",
  paw: "M12 20c-3 0-5-1.5-5-3.5S9.5 12 12 12s5 2.5 5 4.5S15 20 12 20ZM6 11a1.8 2.2 0 1 0 0-.1M18 11a1.8 2.2 0 1 0 0-.1M9 7a1.8 2.2 0 1 0 0-.1M15 7a1.8 2.2 0 1 0 0-.1",
  coffee: "M4 9h13v5a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6zM17 11h1.5a2.5 2.5 0 0 1 0 5H17M8 3v3M12 3v3",
  anchor: "M12 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM12 8v13M5 13a7 7 0 0 0 14 0M8 11h8",
  diamond: "M6 3h12l4 6-10 12L2 9zM2 9h20M9 3l3 18M15 3l-3 18",
};

export type IconName = keyof typeof P | string;

export function Icon({ name, size = 20, strokeWidth = 1.8, filled = false, ...rest }: { name: IconName; size?: number; strokeWidth?: number; filled?: boolean } & SVGProps<SVGSVGElement>) {
  const d = P[name] ?? P.sparkle!;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      <path d={d} />
    </svg>
  );
}
