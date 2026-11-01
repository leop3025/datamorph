export function Logo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="5" fill="var(--accent)" />
      <rect x="6" y="12" width="3" height="6" rx="1" fill="var(--accent-fg)" />
      <rect x="10.5" y="8" width="3" height="10" rx="1" fill="var(--accent-fg)" />
      <rect x="15" y="5" width="3" height="13" rx="1" fill="var(--accent-fg)" />
    </svg>
  );
}
