type BrandmarkProps = { className?: string };

// Busforge brandmark: the KNX bus topology (bus line with device nodes).
// Renders the glyph only in currentColor; place it inside a colored container
// (e.g. the amber `bg-primary text-primary-foreground` box in the header).
export function Brandmark({ className }: BrandmarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 22.5H28" />
      <path d="M9 22.5V15" />
      <path d="M23 22.5V15" />
      <path d="M16 22.5V11.5" />
      <rect x="6.2" y="9.4" width="5.6" height="5.6" rx="1.4" />
      <rect x="20.2" y="9.4" width="5.6" height="5.6" rx="1.4" />
      <rect x="11.8" y="4.6" width="8.4" height="6.9" rx="1.7" />
      <g fill="currentColor" stroke="none">
        <circle cx="9" cy="22.5" r="1.7" />
        <circle cx="16" cy="22.5" r="1.7" />
        <circle cx="23" cy="22.5" r="1.7" />
      </g>
    </svg>
  );
}
