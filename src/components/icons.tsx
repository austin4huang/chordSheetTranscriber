// Shared inline icons. Stroke uses currentColor so they take the button's
// text color automatically.

/** Down-arrow dropping into an open tray — the "download / export" action. */
export function DownloadIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: "-2px", marginRight: "0.35em" }}
    >
      {/* arrow */}
      <path d="M12 3v11" />
      <path d="M8 10l4 4 4-4" />
      {/* tray */}
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}
