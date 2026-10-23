import { cn } from '@/lib/utils';

/**
 * Typeset wordmark. Intentionally not a drawn "logo": the real brand asset is
 * uploaded by the admin in Settings → Branding and is then used on receipts
 * and in-app. Until then LunaDesk shows this neutral lockup rather than an
 * invented mark.
 */
export function LunaMark({ className, size = 32 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      role="img"
      aria-label="LunaDesk"
      className={cn('shrink-0', className)}
    >
      <defs>
        <linearGradient id="luna-mark" x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FF2D95" />
          <stop offset="1" stopColor="#FFB5D5" />
        </linearGradient>
      </defs>
      <rect x="0.75" y="0.75" width="38.5" height="38.5" rx="11" fill="#15151D" stroke="rgba(199,203,212,0.18)" />
      <path d="M26.4 11.2a9.6 9.6 0 1 0 0 17.6 11.2 11.2 0 0 1 0-17.6Z" fill="url(#luna-mark)" />
      <circle cx="14.2" cy="27.4" r="1.35" fill="#A8D8FF" />
    </svg>
  );
}

export function Wordmark({
  compact = false,
  className,
  logoUrl,
  companyName = 'Managed by Luna',
}: {
  compact?: boolean;
  className?: string;
  logoUrl?: string | null;
  companyName?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={companyName}
          className="h-8 w-8 shrink-0 rounded-[10px] border bg-raised object-contain p-1"
          style={{ borderColor: 'rgb(var(--line) / 0.2)' }}
        />
      ) : (
        <LunaMark size={compact ? 28 : 32} />
      )}
      <div className="min-w-0 leading-none">
        <p className="text-[15px] font-semibold tracking-[-0.02em] text-fg">LunaDesk</p>
        <p className="mt-1 truncate text-[10px] uppercase tracking-[0.16em] text-faint">{companyName}</p>
      </div>
    </div>
  );
}
