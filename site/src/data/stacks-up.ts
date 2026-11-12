/**
 * Shared “How NotchOS stacks up” matrix — same columns on every /vs page.
 * Competitor cells are approximate; pages tell readers to verify upstream.
 */

export type StackCell = string; // "Yes" | "—" | price / note

export interface StackRow {
  feature: string;
  notchos: StackCell;
  alcove: StackCell;
  notchnook: StackCell;
  droppy: StackCell;
  boring: StackCell;
  dynamiclake: StackCell;
  mediamate: StackCell;
}

export const STACKS_COLUMNS = [
  { id: 'notchos', label: 'NotchOS', highlight: true },
  { id: 'alcove', label: 'Alcove', highlight: false },
  { id: 'notchnook', label: 'NotchNook', highlight: false },
  { id: 'droppy', label: 'Droppy', highlight: false },
  { id: 'boring', label: 'Boring Notch', highlight: false },
  { id: 'dynamiclake', label: 'DynamicLake', highlight: false },
  { id: 'mediamate', label: 'MediaMate', highlight: false },
] as const;

export const STACKS_ROWS: StackRow[] = [
  {
    feature: 'Price',
    notchos: '$15 lifetime / $3 mo (7-day trial)',
    alcove: '~$14.99 one-time',
    notchnook: '~$15 / ~$2 mo',
    droppy: '~$9.99 one-time',
    boring: 'Free (OSS)',
    dynamiclake: 'Paid',
    mediamate: 'Paid',
  },
  {
    feature: 'Minimum macOS',
    notchos: 'macOS 26+ (Apple silicon)',
    alcove: 'macOS 15+',
    notchnook: 'macOS 14+',
    droppy: 'macOS 14+',
    boring: 'macOS 14+',
    dynamiclake: 'macOS 14+',
    mediamate: 'macOS 13+',
  },
  {
    feature: 'Architecture',
    notchos: 'Native SwiftUI',
    alcove: 'Swift (Native)',
    notchnook: 'Swift (Native)',
    droppy: 'Swift (Native)',
    boring: 'Swift (OSS)',
    dynamiclake: 'Swift (Native)',
    mediamate: 'Swift (Native)',
  },
  {
    feature: 'Dynamic Island / notch UI',
    notchos: 'Yes',
    alcove: 'Yes',
    notchnook: 'Yes',
    droppy: 'Yes',
    boring: 'Yes',
    dynamiclake: 'Yes',
    mediamate: 'HUD focus',
  },
  {
    feature: 'File tray / shelf',
    notchos: 'Yes',
    alcove: '—',
    notchnook: 'Yes',
    droppy: 'Yes',
    boring: 'Basic',
    dynamiclake: '—',
    mediamate: '—',
  },
  {
    feature: 'Clipboard history',
    notchos: 'Yes',
    alcove: '—',
    notchnook: '—',
    droppy: '—',
    boring: '—',
    dynamiclake: '—',
    mediamate: '—',
  },
  {
    feature: 'Calendar & tasks',
    notchos: 'Yes',
    alcove: '—',
    notchnook: 'Widgets',
    droppy: '—',
    boring: 'Calendar',
    dynamiclake: 'Widgets',
    mediamate: '—',
  },
  {
    feature: 'Timers + Keep Awake',
    notchos: 'Yes',
    alcove: '—',
    notchnook: '—',
    droppy: '—',
    boring: '—',
    dynamiclake: 'Timers',
    mediamate: '—',
  },
  {
    feature: 'Teleprompter',
    notchos: 'Yes',
    alcove: '—',
    notchnook: '—',
    droppy: '—',
    boring: '—',
    dynamiclake: '—',
    mediamate: '—',
  },
  {
    feature: 'Android Share',
    notchos: 'Yes (Pro)',
    alcove: '—',
    notchnook: '—',
    droppy: '—',
    boring: '—',
    dynamiclake: '—',
    mediamate: '—',
  },
  {
    feature: 'On-device writing / AI',
    notchos: 'Yes (Pro)',
    alcove: '—',
    notchnook: '—',
    droppy: '—',
    boring: '—',
    dynamiclake: '—',
    mediamate: '—',
  },
  {
    feature: 'System vitals',
    notchos: 'Yes',
    alcove: '—',
    notchnook: '—',
    droppy: '—',
    boring: '—',
    dynamiclake: '—',
    mediamate: '—',
  },
  {
    feature: 'Now Playing / media',
    notchos: 'Yes',
    alcove: 'Yes (polish)',
    notchnook: 'Yes',
    droppy: 'Yes',
    boring: 'Yes',
    dynamiclake: 'Yes',
    mediamate: 'Yes',
  },
  {
    feature: 'System HUDs (vol/bright)',
    notchos: 'Island + faces',
    alcove: 'Yes',
    notchnook: 'Yes',
    droppy: 'Yes',
    boring: 'Yes',
    dynamiclake: 'Yes',
    mediamate: 'Yes (focus)',
  },
];
