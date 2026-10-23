import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Fingerprint, KeyRound, LogOut, ShieldAlert, ShieldCheck, Smartphone } from 'lucide-react';
import { Badge, Button, EmptyState, Field, PageHeader, SkeletonRows, TextInput } from '@/components/ui';
import { useCollection, useData, useToast } from '@/context/app';
import { useAuth } from '@/context/auth';
import { fmtDateTime, fmtRelative } from '@/lib/dates';
import type { AuditLog } from '@/lib/types';

const passwordSchema = z
  .object({
    password: z.string().min(10, 'Use at least 10 characters.'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match.' });

export default function SecurityPage() {
  const { profile, signOut } = useAuth();
  const { adapters, invalidate } = useData();
  const toast = useToast();
  const live = adapters.mode === 'live';

  const { data: logs, loading } = useCollection<AuditLog>('audit_logs');
  const [saving, setSaving] = useState(false);
  const [mfaState, setMfaState] = useState<'unknown' | 'enrolled' | 'none'>('unknown');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [factorSecret, setFactorSecret] = useState<string | null>(null);

  // Local form state (react-hook-form would be overkill for two fields, but the
  // Zod schema still owns validation so the rules live in one place).
  const { register, handleSubmit, reset, formState } = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
  });

  useEffect(() => {
    if (!live) return;
    void (async () => {
      const { supabase } = await import('@/lib/data/supabase');
      const { data } = (await supabase?.auth.mfa.listFactors()) ?? { data: null };
      const totp = data?.totp ?? [];
      setMfaState(totp.some((f) => f.status === 'verified') ? 'enrolled' : 'none');
    })();
  }, [live]);

  const changePassword = handleSubmit(async ({ password }) => {
    if (!live) return;
    setSaving(true);
    try {
      const { supabase } = await import('@/lib/data/supabase');
      const { error } = (await supabase?.auth.updateUser({ password })) ?? { error: new Error('Supabase is unavailable') };
      if (error) throw error;
      toast.success('Password updated', 'Other sessions were not signed out automatically — do that below if needed.');
      reset();
    } catch (err) {
      toast.error('Could not update the password', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  });

  const enrollMfa = async () => {
    if (!live) return;
    setMfaBusy(true);
    try {
      const { supabase } = await import('@/lib/data/supabase');
      if (!supabase) throw new Error('Supabase is unavailable');
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (error) throw error;
      setFactorSecret(data.totp.secret);
      setMfaState('none');
      toast.success('Scan the secret in your authenticator app', 'Then enter the 6-digit code to finish enrolment.');
    } catch (err) {
      toast.error('Could not start MFA enrolment', err instanceof Error ? err.message : undefined);
    } finally {
      setMfaBusy(false);
    }
  };

  const signOutEverywhere = async () => {
    try {
      if (live) {
        const { supabase } = await import('@/lib/data/supabase');
        await supabase?.auth.signOut({ scope: 'global' });
      }
      await signOut();
      invalidate();
      toast.success('Signed out of all sessions');
    } catch {
      toast.error('Could not sign out everywhere');
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="System"
        title="Account & security"
        description="Administrator identity, session control and the audit trail behind every financial change."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="surface p-5">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <ShieldCheck className="h-4 w-4 text-mint" aria-hidden /> Signed in as
          </h2>
          <dl className="mt-3 space-y-2 text-[12.5px]">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Name</dt>
              <dd className="text-fg">{profile?.full_name}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Email</dt>
              <dd className="truncate text-fg">{profile?.email ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Role</dt>
              <dd><Badge tone="magenta">administrator</Badge></dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Account created</dt>
              <dd className="text-fg">{profile ? fmtDateTime(profile.created_at) : '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Last seen</dt>
              <dd className="text-fg">{profile?.last_seen_at ? fmtRelative(profile.last_seen_at) : '—'}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="danger" onClick={() => void signOutEverywhere()} icon={<LogOut className="h-3.5 w-3.5" />}>
              Sign out everywhere
            </Button>
          </div>
          <p className="mt-3 text-[10.5px] leading-relaxed text-faint">
            Signing out everywhere revokes refresh tokens. Any client portals stay signed in — their sessions are separate.
          </p>
        </section>

        <section className="surface p-5">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <KeyRound className="h-4 w-4 text-faint" aria-hidden /> Password
          </h2>
          {!live ? (
            <div className="mt-3 rounded-xl border border-butter/25 bg-butter/[0.06] p-3">
              <p className="text-[11.5px] font-medium text-accent-butter">Available on your live Supabase project</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                In demo mode there is no auth server, so password changes are disabled rather than faked. Connect Supabase
                (<code className="font-mono">VITE_DATA_MODE=live</code>) and this form updates the real account.
              </p>
            </div>
          ) : (
            <form onSubmit={changePassword} className="mt-3 space-y-3" noValidate>
              <Field label="New password" error={formState.errors.password?.message} hint="At least 10 characters. Use a passphrase." required>
                {(id) => <TextInput id={id} type="password" autoComplete="new-password" {...register('password')} />}
              </Field>
              <Field label="Confirm password" error={formState.errors.confirm?.message} required>
                {(id) => <TextInput id={id} type="password" autoComplete="new-password" {...register('confirm')} />}
              </Field>
              <Button type="submit" variant="primary" loading={saving}>Update password</Button>
            </form>
          )}
        </section>

        <section className="surface p-5">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <Smartphone className="h-4 w-4 text-faint" aria-hidden /> Two-factor authentication
          </h2>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
            A TOTP authenticator factor. Strongly recommended for the only account that can move money.
          </p>
          {!live ? (
            <p className="mt-3 rounded-xl border p-3 text-[11px] leading-relaxed text-muted" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
              MFA enrolment requires Supabase Auth (TOTP). In demo mode this panel explains the control instead of pretending
              to enrol a factor.
            </p>
          ) : mfaState === 'enrolled' ? (
            <Badge tone="mint" className="mt-3" dot>Authenticator enrolled</Badge>
          ) : factorSecret ? (
            <div className="mt-3 rounded-xl border border-sky/30 bg-sky/[0.06] p-3">
              <p className="text-[10px] uppercase tracking-[0.14em] text-accent-sky">Add this secret to your authenticator</p>
              <p className="mt-1 break-all font-mono text-[12px] text-fg">{factorSecret}</p>
              <p className="mt-1.5 text-[10.5px] text-muted">Confirm the 6-digit code in Supabase’s MFA challenge to activate the factor.</p>
            </div>
          ) : (
            <Button variant="ghost" className="mt-3" loading={mfaBusy} onClick={() => void enrollMfa()} icon={<Fingerprint className="h-3.5 w-3.5" />}>
              Set up an authenticator
            </Button>
          )}
        </section>

        <section className="surface p-5">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <ShieldAlert className="h-4 w-4 text-butter" aria-hidden /> How access is enforced
          </h2>
          <ul className="mt-3 space-y-2 text-[11.5px] leading-relaxed text-muted">
            <li className="flex gap-2"><span className="text-mint">01</span> Access codes are verified by an Edge Function, hashed at rest, rate-limited per IP and per code.</li>
            <li className="flex gap-2"><span className="text-mint">02</span> A successful exchange returns a one-time token that is immediately traded for a Supabase session.</li>
            <li className="flex gap-2"><span className="text-mint">03</span> Role lives in <code className="font-mono">profiles.role</code> and is re-checked by RLS on every query — never by the URL.</li>
            <li className="flex gap-2"><span className="text-mint">04</span> Client sessions can read only rows whose <code className="font-mono">client_id</code> equals their own membership.</li>
            <li className="flex gap-2"><span className="text-mint">05</span> Money-moving and code-rotating RPCs are SECURITY DEFINER functions that assert the admin role themselves.</li>
          </ul>
        </section>
      </div>

      <section className="surface mt-4 p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg">Audit trail</h2>
          <span className="text-[10.5px] text-faint">{logs.length} recorded events</span>
        </div>
        {loading ? (
          <SkeletonRows rows={4} />
        ) : logs.length === 0 ? (
          <EmptyState
            compact
            title="No audit events yet"
            description="Payments, voids, receipt issuance and access changes are logged automatically with the actor and timestamp."
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                </tr>
              </thead>
              <tbody>
                {logs.slice(0, 25).map((log) => (
                  <tr key={log.id}>
                    <td className="whitespace-nowrap text-[11px] text-muted">{fmtDateTime(log.created_at)}</td>
                    <td className="text-[11.5px] text-fg">{log.actor_label ?? 'System'}</td>
                    <td className="text-[11.5px] text-muted">{log.action.replace(/[._]/g, ' ')}</td>
                    <td><Badge tone="muted">{log.entity}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
