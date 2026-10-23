import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion } from 'framer-motion';
import { AlertCircle, ArrowRight, Eye, EyeOff, KeyRound, Loader2, Lock, Mail, ShieldCheck, Sparkles } from 'lucide-react';
import { Wordmark } from '@/components/brand/Logo';
import { Button, Field, Segmented, TextInput } from '@/components/ui';
import { useAuth } from '@/context/auth';
import { DATA_MODE, useData, useReducedMotion, useTheme } from '@/context/app';
import { DEMO_CREDENTIALS } from '@/lib/data/seed';
import { cn } from '@/lib/utils';

const LunaScene = lazy(() => import('@/components/three/LunaScene'));

const codeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(4, 'Access codes are at least 4 characters.')
    .max(24, 'That code is too long.')
    .regex(/^[A-Za-z0-9-]+$/, 'Letters and numbers only.'),
});

const adminCodeSchema = z.object({
  code: z.string().trim().min(4, 'Enter your administrator code.'),
  password: z.string().min(8, 'Enter your administrator password (8+ characters).'),
});

const emailSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(8, 'Enter your password (8+ characters).'),
});

const magicSchema = z.object({ email: z.string().trim().email('Enter a valid email address.') });

type EntryMode = 'client' | 'admin';
type AdminMethod = 'code' | 'password' | 'magic';

export default function LoginPage() {
  const navigate = useNavigate();
  const { status, profile, signInWithAccessCode, signInAdminWithCode, signInWithPassword, sendMagicLink } = useAuth();
  const { adapters } = useData();
  const { choice, setChoice } = useTheme();
  const reduced = useReducedMotion();

  const [mode, setMode] = useState<EntryMode>('client');
  const [adminMethod, setAdminMethod] = useState<AdminMethod>('code');
  const [showCode, setShowCode] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const errorRef = useRef<HTMLDivElement>(null);

  const clientForm = useForm<z.infer<typeof codeSchema>>({ resolver: zodResolver(codeSchema), defaultValues: { code: '' } });
  const adminCodeForm = useForm<z.infer<typeof adminCodeSchema>>({ resolver: zodResolver(adminCodeSchema) });
  const adminEmailForm = useForm<z.infer<typeof emailSchema>>({ resolver: zodResolver(emailSchema) });
  const magicForm = useForm<z.infer<typeof magicSchema>>({ resolver: zodResolver(magicSchema) });

  // Already signed in? Route by the server-verified role, never by URL.
  useEffect(() => {
    if (status !== 'signedIn' || !profile) return;
    navigate(profile.role === 'admin' ? '/admin' : '/portal', { replace: true });
  }, [status, profile, navigate]);

  useEffect(() => {
    if (!lockUntil) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((lockUntil - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) setLockUntil(null);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [lockUntil]);

  const handleResult = (ok: boolean, error?: string, retryAfterSeconds?: number) => {
    if (ok) return;
    setFormError(error ?? 'Sign-in failed. Please try again.');
    if (retryAfterSeconds) setLockUntil(Date.now() + retryAfterSeconds * 1000);
    window.setTimeout(() => errorRef.current?.focus(), 30);
  };

  const onClientSubmit = clientForm.handleSubmit(async ({ code }) => {
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const result = await signInWithAccessCode(code);
      if (!result.ok) handleResult(false, result.error, result.retryAfterSeconds);
    } catch {
      handleResult(false, 'We could not reach the sign-in service. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  });

  const onAdminCodeSubmit = adminCodeForm.handleSubmit(async ({ code, password }) => {
    setBusy(true);
    setFormError(null);
    try {
      const result = await signInAdminWithCode(code, password);
      if (!result.ok) handleResult(false, result.error);
    } catch {
      handleResult(false, 'Administrator sign-in is unavailable right now.');
    } finally {
      setBusy(false);
    }
  });

  const onAdminEmailSubmit = adminEmailForm.handleSubmit(async ({ email, password }) => {
    setBusy(true);
    setFormError(null);
    try {
      const result = await signInWithPassword(email, password);
      if (!result.ok) handleResult(false, result.error ?? 'Those details were not accepted.');
      else if (adapters.mode === 'live') {
        // Supabase returns a session; role is verified server-side on the next read.
        setNotice('Signed in. Opening your workspace…');
      }
    } catch {
      handleResult(false, 'Administrator sign-in is unavailable right now.');
    } finally {
      setBusy(false);
    }
  });

  const onMagicSubmit = magicForm.handleSubmit(async ({ email }) => {
    setBusy(true);
    setFormError(null);
    try {
      const result = await sendMagicLink(email);
      if (result.ok) {
        setNotice(
          adapters.mode === 'live'
            ? `If ${email} belongs to an administrator, a single-use sign-in link is on its way. The link expires in 15 minutes.`
            : 'Demo mode signs you straight in — no email is sent.',
        );
      } else {
        handleResult(false, result.error);
      }
    } finally {
      setBusy(false);
    }
  });

  const fillCode = (code: string) => {
    clientForm.setValue('code', code);
    setMode('client');
    void clientForm.handleSubmit(() => {})();
    clientForm.setFocus('code');
  };

  return (
    <div className="relative z-10 min-h-dvh lg:grid lg:grid-cols-[1.05fr_minmax(420px,0.95fr)]">
      {/* ------------------------------ Brand panel ------------------------------ */}
      <section className="relative hidden overflow-hidden border-r lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="absolute inset-0 grid-bg opacity-60" aria-hidden />
        <div className="relative">
          <Wordmark companyName="Managed by Luna" />
        </div>

        <div className="relative">
          <div
            className="pointer-events-none absolute inset-y-0 right-0 w-[66%] opacity-95"
            style={{ maskImage: "linear-gradient(to right, transparent, black 22%, black 92%, transparent)", WebkitMaskImage: "linear-gradient(to right, transparent, black 22%, black 92%, transparent)" }}
          >
            {!reduced ? (
              <Suspense fallback={null}>
                <LunaScene />
              </Suspense>
            ) : (
              <div className="absolute right-4 top-8 h-56 w-56 rounded-full bg-magenta/20 blur-3xl" aria-hidden />
            )}
          </div>
          <div className="relative max-w-md pt-24">
            <p className="eyebrow mb-4 text-magenta">Managed by Luna</p>
            <h1 className="display text-[clamp(2.4rem,4vw,3.4rem)] text-fg">
              Your Workspace.
              <br />
              Your World.
            </h1>
            <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-muted">
              Everything your team manages, organized in one place.
            </p>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[11px] text-faint">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-mint" aria-hidden /> Server-verified access
              </span>
              <span className="flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5 text-sky" aria-hidden /> Private by default
              </span>
            </div>
          </div>
        </div>

        <div className="relative flex items-center justify-between text-[11px] text-faint">
          <span>© {new Date().getFullYear()} Managed by Luna</span>
          <button
            type="button"
            onClick={() => setChoice(choice === 'dark' ? 'light' : 'dark')}
            className="rounded-md px-2 py-1 transition hover:text-fg"
          >
            {choice === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </section>

      {/* ------------------------------ Access panel ----------------------------- */}
      <section className="relative flex min-h-dvh flex-col justify-center px-5 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-[420px]">
          <div className="mb-8 lg:hidden">
            <Wordmark companyName="Managed by Luna" />
          </div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <p className="eyebrow mb-2">{mode === 'client' ? 'Client portal' : 'Administrator'}</p>
            <h2 className="display text-[26px] text-fg">
              {mode === 'client' ? 'Enter your access code' : 'Administrator sign-in'}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {mode === 'client'
                ? 'Your code is issued by Managed by Luna. It opens your projects, services and billing — and nothing else.'
                : 'The admin workspace requires a verified account. A code on its own is never enough.'}
            </p>

            <div className="mt-6">
              <Segmented
                ariaLabel="Sign-in type"
                value={mode}
                onChange={(v) => {
                  setMode(v);
                  setFormError(null);
                  setNotice(null);
                }}
                options={[
                  { value: 'client', label: 'Client access' },
                  { value: 'admin', label: 'Administrator' },
                ]}
              />
            </div>

            {formError && (
              <div
                ref={errorRef}
                tabIndex={-1}
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-xl border border-magenta/30 bg-magenta/[0.07] px-3 py-2.5 text-xs leading-relaxed text-accent-danger"
              >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{formError}</span>
              </div>
            )}
            {notice && (
              <div className="mt-4 flex items-start gap-2 rounded-xl border border-sky/30 bg-sky/[0.07] px-3 py-2.5 text-xs leading-relaxed text-accent-sky" role="status">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{notice}</span>
              </div>
            )}
            {lockUntil && (
              <p className="mt-2 text-[11px] text-faint" aria-live="polite">
                Too many attempts. You can try again in {secondsLeft}s.
              </p>
            )}

            {mode === 'client' ? (
              <form onSubmit={onClientSubmit} className="mt-5 space-y-4" noValidate>
                <Field
                  label="Access code"
                  error={clientForm.formState.errors.code?.message}
                  hint="Example format: PR103"
                  required
                >
                  {(id) => (
                    <div className="relative">
                      <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
                      <TextInput
                        id={id}
                        {...clientForm.register('code')}
                        type={showCode ? 'text' : 'password'}
                        inputMode="text"
                        autoComplete="one-time-code"
                        autoCapitalize="characters"
                        autoFocus
                        spellCheck={false}
                        placeholder="Enter your code"
                        aria-invalid={Boolean(clientForm.formState.errors.code)}
                        className={cn('pl-9 pr-10 font-mono uppercase tracking-[0.2em] placeholder:normal-case placeholder:font-sans placeholder:tracking-normal placeholder:text-[13px]')}
                      />
                      <button
                        type="button"
                        onClick={() => setShowCode((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-faint transition hover:bg-raised hover:text-fg"
                        aria-label={showCode ? 'Hide access code' : 'Show access code'}
                        aria-pressed={showCode}
                      >
                        {showCode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  )}
                </Field>

                <Button type="submit" variant="primary" size="lg" fullWidth loading={busy} iconRight={!busy ? <ArrowRight className="h-4 w-4" aria-hidden /> : undefined}>
                  {busy ? 'Verifying…' : 'Continue'}
                </Button>

                <p className="text-center text-[11px] leading-relaxed text-faint">
                  Lost your code? Ask your contact at{' '}
                  <a href="mailto:hello@managedbyluna.com" className="text-muted underline decoration-[rgb(var(--line)/0.4)] underline-offset-2 hover:text-fg">
                    Managed by Luna
                  </a>
                  .
                </p>
              </form>
            ) : (
              <div className="mt-5">
                <Segmented
                  size="sm"
                  ariaLabel="Administrator method"
                  value={adminMethod}
                  onChange={(v) => {
                    setAdminMethod(v);
                    setFormError(null);
                  }}
                  options={[
                    { value: 'code', label: 'Code + password' },
                    { value: 'password', label: 'Email' },
                    { value: 'magic', label: 'Magic link' },
                  ]}
                />

                {adminMethod === 'code' && (
                  <form onSubmit={onAdminCodeSubmit} className="mt-4 space-y-4" noValidate>
                    <Field label="Administrator code" error={adminCodeForm.formState.errors.code?.message} required>
                      {(id) => (
                        <TextInput
                          id={id}
                          {...adminCodeForm.register('code')}
                          autoComplete="off"
                          autoFocus
                          placeholder="ADI000"
                          className="font-mono uppercase tracking-[0.2em]"
                        />
                      )}
                    </Field>
                    <Field label="Password" error={adminCodeForm.formState.errors.password?.message} required>
                      {(id) => (
                        <div className="relative">
                          <TextInput
                            id={id}
                            {...adminCodeForm.register('password')}
                            type={showPassword ? 'text' : 'password'}
                            autoComplete="current-password"
                            placeholder="••••••••"
                            className="pr-10"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword((v) => !v)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-faint transition hover:bg-raised hover:text-fg"
                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                          >
                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                      )}
                    </Field>
                    <Button type="submit" variant="primary" size="lg" fullWidth loading={busy}>
                      {busy ? 'Signing in…' : 'Sign in'}
                    </Button>
                    <p className="text-[11px] leading-relaxed text-faint">
                      The code identifies the account; your password authenticates it. Every admin action is then
                      authorised again by row-level security on the server.
                    </p>
                  </form>
                )}

                {adminMethod === 'password' && (
                  <form onSubmit={onAdminEmailSubmit} className="mt-4 space-y-4" noValidate>
                    <Field label="Email" error={adminEmailForm.formState.errors.email?.message} required>
                      {(id) => (
                        <div className="relative">
                          <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
                          <TextInput
                            id={id}
                            {...adminEmailForm.register('email')}
                            type="email"
                            autoComplete="username"
                            autoFocus
                            placeholder="you@managedbyluna.com"
                            className="pl-9"
                          />
                        </div>
                      )}
                    </Field>
                    <Field label="Password" error={adminEmailForm.formState.errors.password?.message} required>
                      {(id) => (
                        <TextInput id={id} {...adminEmailForm.register('password')} type="password" autoComplete="current-password" placeholder="••••••••" />
                      )}
                    </Field>
                    <Button type="submit" variant="primary" size="lg" fullWidth loading={busy}>
                      {busy ? 'Signing in…' : 'Sign in'}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setAdminMethod('magic')}
                      className="w-full text-center text-[11px] text-muted underline decoration-[rgb(var(--line)/0.4)] underline-offset-2 hover:text-fg"
                    >
                      Forgot your password? Use a one-time sign-in link instead
                    </button>
                  </form>
                )}

                {adminMethod === 'magic' && (
                  <form onSubmit={onMagicSubmit} className="mt-4 space-y-4" noValidate>
                    <Field
                      label="Email"
                      hint="We send a single-use link that expires in 15 minutes."
                      error={magicForm.formState.errors.email?.message}
                      required
                    >
                      {(id) => (
                        <TextInput
                          id={id}
                          {...magicForm.register('email')}
                          type="email"
                          autoComplete="username"
                          autoFocus
                          placeholder="you@managedbyluna.com"
                        />
                      )}
                    </Field>
                    <Button type="submit" variant="primary" size="lg" fullWidth loading={busy}>
                      {busy ? 'Sending…' : 'Email me a sign-in link'}
                    </Button>
                  </form>
                )}
              </div>
            )}

            {DATA_MODE === 'demo' && (
              <aside className="mt-7 rounded-xl border border-dashed p-3.5" style={{ borderColor: 'rgb(var(--line) / 0.22)' }}>
                <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-butter">
                  <Sparkles className="h-3 w-3" aria-hidden /> Demo environment
                </p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                  Not connected to Supabase. Sample codes below open read-only client portals with fictional data.
                </p>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {DEMO_CREDENTIALS.clientCodes.map((code) => (
                    <button
                      key={code}
                      type="button"
                      onClick={() => fillCode(code)}
                      className="rounded-md border px-2 py-1 font-mono text-[11px] text-muted transition hover:border-magenta/40 hover:text-fg"
                      style={{ borderColor: 'rgb(var(--line) / 0.18)' }}
                    >
                      {code}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setMode('admin');
                      setAdminMethod('code');
                      adminCodeForm.setValue('code', DEMO_CREDENTIALS.adminCode);
                      adminCodeForm.setValue('password', DEMO_CREDENTIALS.adminPassword);
                    }}
                    className="rounded-md border border-magenta/35 px-2 py-1 text-[11px] text-magenta transition hover:bg-magenta/10"
                  >
                    Fill admin credentials
                  </button>
                </div>
              </aside>
            )}
          </motion.div>

          <footer className="mt-10 flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-faint">
            <span>Secure sign-in · Session expires when you sign out</span>
            {adapters.mode === 'live' && (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-mint" aria-hidden /> Connected to Supabase
              </span>
            )}
            {busy && (
              <span className="flex items-center gap-1" role="status">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Working…
              </span>
            )}
          </footer>
        </div>
      </section>
    </div>
  );
}
