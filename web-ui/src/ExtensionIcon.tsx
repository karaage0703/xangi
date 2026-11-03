// Small shared vector icons: no uploaded assets or full icon-library bundle.
const paths: Record<string, string> = {
  'xangi-mail': 'M3 5h18v14H3z m0 0 9 8 9-8',
  'xangi-tasks': 'm3 6 2 2 3-4 M11 6h10 M3 13l2 2 3-4 M11 13h10 M3 20h5 M11 20h10',
  'xangi-terminal': 'M3 4h18v16H3z m4 4 4 4-4 4 m6 0h4',
  'xangi-search': 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 m5 12 6 6',
  'xangi-studio': 'M4 3h16v18H4z M8 7h8 M8 11h5 M8 15h8 M8 18h5',
  'xangi-dashboard': 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  'xangi-stackchan': 'M4 7h16v13H4z M12 7V3 M10 3h4 M8 12h1 M15 12h1 M8 16q4 3 8 0',
  'xangi-even-g2': 'M2 10h8v6H2z M14 10h8v6h-8z M10 12h4 M2 10l2-5 M22 10l-2-5',
  'xangi-avatar': 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M4 21v-3a8 5 0 0 1 16 0v3',
  'xangi-stopwatch': 'M12 7a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M9 3h6 M12 3v4 M12 10v5l3 2 M18 8l2-2',
  'xangi-dots':
    'M5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M19 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
  'xangi-muse': 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  'xangi-dots-muse': 'M3 5h12v10H8l-4 4v-4H3z M18 9h3v12l-4-3h-5',
  'xangi-remote-desktop': 'M2 3h20v14H2z M8 21h8 M12 17v4 m-3-10 3-3 3 3 M12 8v6',
};
const fallback = 'M3 3h7v5a2 2 0 1 0 4 0V3h7v7h-5a2 2 0 1 0 0 4h5v7h-7v-5a2 2 0 1 0-4 0v5H3z';

export function ExtensionIcon({ id }: { id: string }) {
  return (
    <svg
      className="app-navigation-icon extension-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[id] || fallback} />
    </svg>
  );
}

export function shortExtensionName(name: string) {
  return name.replace(/^xangi-/i, '') || name;
}
