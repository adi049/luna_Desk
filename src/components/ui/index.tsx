import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Loader2, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/money';

/* ---------------------------------------------------------------- Button */

type ButtonVariant = 'primary' | 'ghost' | 'quiet' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

const sizeClass: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-[13px] rounded-lg gap-1.5',
  md: 'px-4 py-2.5 text-sm rounded-xl gap-2',
  lg: 'px-5 py-3 text-[15px] rounded-xl gap-2',
};

const variantClass: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  quiet: 'btn-quiet',
  danger: 'btn-danger',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'md', loading, icon, iconRight, fullWidth, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn('btn', variantClass[variant], sizeClass[size], fullWidth && 'w-full', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
      {iconRight}
    </button>
  );
});

/* ----------------------------------------------------------------- Field */

interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: (id: string) => ReactNode;
}

export function Field({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn('min-w-0', className)}>
      {label && (
        <label htmlFor={id} className="label">
          {label}
          {required && (
            <span className="ml-1 text-magenta" aria-hidden>
              *
            </span>
          )}
        </label>
      )}
      {children(id)}
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs text-magenta">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-faint">
          {hint}
        </p>
      ) : null}
      {describedBy ? null : null}
    </div>
  );
}

/** Convenience wrapper that wires Field + input, including aria-describedby. */
export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return <input ref={ref} className={cn('field', className)} {...rest} />;
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn('field min-h-[84px] resize-y', className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn('field appearance-none pr-9', className)} {...rest}>
        {children}
      </select>
    );
  },
);

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  className,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  label?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className="field pl-9"
      />
    </div>
  );
}

/* ----------------------------------------------------------------- Badge */

export type Tone = 'neutral' | 'magenta' | 'mint' | 'butter' | 'sky' | 'blush' | 'muted';

const toneClass: Record<Tone, string> = {
  neutral: 'border-[rgb(var(--line)/0.18)] bg-[rgb(var(--line)/0.06)] text-muted',
  magenta: 'border-magenta/35 bg-magenta/12 text-magenta',
  mint: 'border-mint/35 bg-mint/12 text-accent-mint',
  butter: 'border-butter/35 bg-butter/12 text-accent-butter',
  sky: 'border-sky/35 bg-sky/12 text-accent-sky',
  blush: 'border-blush/35 bg-blush/12 text-accent-blush',
  muted: 'border-[rgb(var(--line)/0.12)] bg-transparent text-faint',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
  dot,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span className={cn('chip', toneClass[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------ EmptyState */

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed text-center',
        compact ? 'px-4 py-8' : 'px-6 py-14',
      )}
      style={{ borderColor: 'rgb(var(--line) / 0.16)' }}
    >
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="text-sm font-medium text-fg">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------- Skeleton */

export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-12 w-full" />
      ))}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-xs text-faint">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

/* -------------------------------------------------------------- StatCard */

export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
  index = 0,
  onClick,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  index?: number;
  onClick?: () => void;
}) {
  const accent: Record<Tone, string> = {
    neutral: 'text-fg',
    magenta: 'text-magenta',
    mint: 'text-accent-mint',
    butter: 'text-accent-butter',
    sky: 'text-accent-sky',
    blush: 'text-accent-blush',
    muted: 'text-muted',
  };
  const Tag = onClick ? 'button' : 'div';
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.3), duration: 0.35, ease: [0.22, 0.61, 0.36, 1] }}
    >
      <Tag
        type={onClick ? 'button' : undefined}
        onClick={onClick}
        className={cn(
          'surface group h-full w-full p-4 text-left transition',
          onClick && 'hover:border-[rgb(var(--line)/0.26)] hover:bg-surface',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="eyebrow">{label}</p>
          {icon && <span className="text-faint transition group-hover:text-muted">{icon}</span>}
        </div>
        <p className={cn('num mt-2 text-2xl font-semibold tracking-tight', accent[tone])}>{value}</p>
        {hint && <p className="mt-1 text-[11px] leading-snug text-faint">{hint}</p>}
      </Tag>
    </motion.div>
  );
}

/* ---------------------------------------------------------- PageHeader */

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1.5">{eyebrow}</p>}
        <h1 className="display text-2xl text-fg sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ Segmented */

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; count?: number }[];
  size?: 'sm' | 'md';
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex flex-wrap items-center gap-0.5 rounded-xl border bg-raised/60 p-0.5"
      style={{ borderColor: 'rgb(var(--line) / 0.14)' }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              'relative rounded-[10px] font-medium transition',
              size === 'sm' ? 'px-2.5 py-1 text-[11.5px]' : 'px-3 py-1.5 text-xs',
              active ? 'text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${ariaLabel}`}
                className="absolute inset-0 rounded-[10px] bg-[rgb(var(--line)/0.13)]"
                transition={{ type: 'spring', stiffness: 480, damping: 38 }}
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {opt.label}
              {typeof opt.count === 'number' && (
                <span className={cn('num text-[10px]', active ? 'text-muted' : 'text-faint')}>{opt.count}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------- Pagination */

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
      <p className="num text-xs text-faint">
        {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          icon={<ChevronLeft className="h-3.5 w-3.5" />}
        />
        <span className="num px-2 text-xs text-muted">
          {page} / {pages}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pages}
          aria-label="Next page"
          icon={<ChevronRight className="h-3.5 w-3.5" />}
        />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- Toolbar */

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mb-4 flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

/* --------------------------------------------------------- Money text */

export function Money({
  minor,
  className,
  tone,
  compact,
}: {
  minor: number;
  className?: string;
  tone?: 'mint' | 'magenta' | 'butter' | 'sky' | 'neutral';
  compact?: boolean;
}) {
  const toneClassMap = {
    mint: 'text-accent-mint',
    magenta: 'text-magenta',
    butter: 'text-accent-butter',
    sky: 'text-accent-sky',
    neutral: '',
  } as const;
  return <span className={cn('num', tone && toneClassMap[tone], className)}>{formatMoney(minor, { compact })}</span>;
}
