interface IconProps {
  className?: string;
}

const base = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
};

export function IconPull({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M8 2.5v7.4" />
      <path d="M4.9 7.1 8 10.2l3.1-3.1" />
      <path d="M2.75 13h10.5" />
    </svg>
  );
}

export function IconSearch({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="7" cy="7" r="4.1" />
      <path d="m10.1 10.1 2.9 2.9" />
    </svg>
  );
}

export function IconClose({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
    </svg>
  );
}

export function IconChevronDown({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="m4.4 6.4 3.6 3.6 3.6-3.6" />
    </svg>
  );
}

export function IconTape({ className }: IconProps) {
  return (
    <svg {...base} className={className} strokeWidth={1.2}>
      <rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.2" />
      <path d="M2.4 6.3h11.2M5.2 9.1h4.6M5.2 10.9h2.6" />
    </svg>
  );
}
