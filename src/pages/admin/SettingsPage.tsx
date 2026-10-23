import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Bell,
  Building2,
  Image as ImageIcon,
  Moon,
  Palette,
  ReceiptText,
  Sun,
  Upload,
  User,
  Volume2,
} from 'lucide-react';
import {
  Badge,
  Button,
  Field,
  PageHeader,
  Select,
  SkeletonRows,
  TextArea,
  TextInput,
} from '@/components/ui';
import { useCollection, useData, useTheme, useToast } from '@/context/app';
import { useAuth } from '@/context/auth';
import { alarmPlayer, type AlarmTone } from '@/lib/alarm';
import { notificationSupport, requestNotificationPermission, showNotification, type PermissionState } from '@/lib/notifications';
import type { BrandingSettings, NotificationPreferences, Profile } from '@/lib/types';
import { cn } from '@/lib/utils';

const profileSchema = z.object({
  full_name: z.string().trim().min(2, 'Enter your name.').max(80),
  email: z.union([z.string().trim().email('Enter a valid email.'), z.literal('')]),
  phone: z.string().trim().max(24).optional(),
  timezone: z.string().min(1),
});

const brandingSchema = z.object({
  company_name: z.string().trim().min(2, 'Company name is required.').max(80),
  contact_email: z.string().trim().email('Enter a valid email.'),
  contact_phone: z.string().trim().max(24).optional(),
  address: z.string().trim().max(300).optional(),
  tax_id: z.string().trim().max(40).optional(),
  tax_label: z.string().trim().max(40).optional(),
  receipt_footer: z.string().trim().max(300),
  receipt_prefix: z.string().trim().min(2).max(16),
  invoice_prefix: z.string().trim().min(2).max(16),
});

type Section = 'profile' | 'appearance' | 'branding' | 'notifications' | 'receipts';

export default function SettingsPage() {
  const { profile, isAdmin, reloadProfile } = useAuth();
  const adapter = useData().adapters.data;
  const { invalidate } = useData();
  const toast = useToast();
  const { choice, setChoice } = useTheme();

  const { data: prefsRows, refresh: refreshPrefs, loading: prefsLoading } = useCollection<NotificationPreferences>('notification_preferences');
  const { data: brandingRows, refresh: refreshBranding, loading: brandingLoading } = useCollection<BrandingSettings>('branding_settings', {}, Boolean(isAdmin));
  const prefs = prefsRows[0];
  const branding = brandingRows[0];

  const [section, setSection] = useState<Section>('profile');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingBranding, setSavingBranding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [permission, setPermission] = useState<PermissionState>('default');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPermission(notificationSupport());
  }, []);

  const profileForm = useForm<z.infer<typeof profileSchema>>({ resolver: zodResolver(profileSchema) });
  const brandingForm = useForm<z.infer<typeof brandingSchema>>({ resolver: zodResolver(brandingSchema) });

  useEffect(() => {
    if (!profile) return;
    profileForm.reset({
      full_name: profile.full_name ?? '',
      email: profile.email ?? '',
      phone: profile.phone ?? '',
      timezone: profile.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }, [profile, profileForm]);

  useEffect(() => {
    if (!branding) return;
    brandingForm.reset({
      company_name: branding.company_name,
      contact_email: branding.contact_email,
      contact_phone: branding.contact_phone ?? '',
      address: branding.address ?? '',
      tax_id: branding.tax_id ?? '',
      tax_label: branding.tax_label ?? '',
      receipt_footer: branding.receipt_footer,
      receipt_prefix: branding.receipt_prefix,
      invoice_prefix: branding.invoice_prefix,
    });
  }, [branding, brandingForm]);

  const saveProfile = profileForm.handleSubmit(async (values) => {
    setSavingProfile(true);
    try {
      await adapter.update<Profile>('profiles', profile!.id, {
        full_name: values.full_name.trim(),
        email: values.email || null,
        phone: values.phone?.trim() || null,
        timezone: values.timezone,
      });
      await reloadProfile();
      toast.success('Profile updated');
      invalidate();
    } catch (err) {
      toast.error('Could not save your profile', err instanceof Error ? err.message : undefined);
    } finally {
      setSavingProfile(false);
    }
  });

  const saveBranding = brandingForm.handleSubmit(async (values) => {
    if (!branding) return;
    setSavingBranding(true);
    try {
      await adapter.update<BrandingSettings>('branding_settings', branding.id, {
        company_name: values.company_name.trim(),
        contact_email: values.contact_email.trim(),
        contact_phone: values.contact_phone?.trim() || null,
        address: values.address?.trim() || null,
        tax_id: values.tax_id?.trim() || null,
        tax_label: values.tax_label?.trim() || null,
        receipt_footer: values.receipt_footer.trim(),
        receipt_prefix: values.receipt_prefix.trim().toUpperCase(),
        invoice_prefix: values.invoice_prefix.trim().toUpperCase(),
      });
      refreshBranding();
      invalidate();
      toast.success('Branding saved', 'New receipts use these details.');
    } catch (err) {
      toast.error('Could not save branding', err instanceof Error ? err.message : undefined);
    } finally {
      setSavingBranding(false);
    }
  });

  const uploadLogo = async (file: File) => {
    if (!branding) return;
    setUploading(true);
    try {
      const url = await adapter.uploadLogo(file);
      await adapter.update<BrandingSettings>('branding_settings', branding.id, { logo_url: url });
      refreshBranding();
      invalidate();
      toast.success('Logo uploaded', 'It now appears in the app header and on receipts.');
    } catch (err) {
      toast.error('Could not upload the logo', err instanceof Error ? err.message : undefined);
    } finally {
      setUploading(false);
    }
  };

  const ensurePrefs = async () => {
    if (prefs) return prefs;
    if (!profile) return null;
    const created = await adapter.insert<NotificationPreferences>('notification_preferences', {
      user_id: profile.id,
      browser_notifications: false,
      alarm_sound: true,
      alarm_volume: 0.6,
      alarm_sound_name: 'pulse',
      email_digest: false,
      quiet_hours_start: null,
      quiet_hours_end: null,
    });
    refreshPrefs();
    return created;
  };

  const updatePrefs = async (patch: Partial<NotificationPreferences>) => {
    const current = await ensurePrefs();
    if (!current) return;
    await adapter.update('notification_preferences', current.user_id, patch);
    refreshPrefs();
    invalidate();
  };

  const enableBrowserNotifications = async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
    await updatePrefs({ browser_notifications: result === 'granted' });
    if (result === 'granted') {
      showNotification('Notifications enabled', { body: 'LunaDesk will alert you when a reminder is due.' });
      toast.success('Browser notifications enabled');
    } else if (result === 'denied') {
      toast.warning('Blocked by the browser', 'Enable LunaDesk notifications in your site settings.');
    }
  };

  const sections: { value: Section; label: string }[] = isAdmin
    ? [
        { value: 'profile', label: 'Profile' },
        { value: 'appearance', label: 'Appearance' },
        { value: 'branding', label: 'Branding' },
        { value: 'notifications', label: 'Notifications' },
        { value: 'receipts', label: 'Receipts' },
      ]
    : [
        { value: 'profile', label: 'Profile' },
        { value: 'appearance', label: 'Appearance' },
        { value: 'notifications', label: 'Notifications' },
      ];

  return (
    <div>
      <PageHeader
        eyebrow="System"
        title="Settings"
        description={isAdmin ? 'Your account, your brand, and how LunaDesk looks and sounds.' : 'Your account preferences and notification settings.'}
      />

      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="surface h-fit p-1.5">
          <ul className="space-y-0.5">
            {sections.map((item) => (
              <li key={item.value}>
                <button
                  type="button"
                  onClick={() => setSection(item.value)}
                  aria-current={section === item.value ? 'true' : undefined}
                  className={cn(
                    'w-full rounded-lg px-2.5 py-2 text-left text-[12.5px] transition',
                    section === item.value ? 'bg-[rgb(var(--line)/0.12)] font-medium text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg',
                  )}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="space-y-4">
          {section === 'profile' && (
            <section className="surface p-5">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                <User className="h-4 w-4 text-faint" aria-hidden /> Profile
              </h2>
              <form onSubmit={saveProfile} className="mt-4 grid gap-4 sm:grid-cols-2" noValidate>
                <Field label="Full name" error={profileForm.formState.errors.full_name?.message} required>
                  {(id) => <TextInput id={id} {...profileForm.register('full_name')} />}
                </Field>
                <Field label="Email" error={profileForm.formState.errors.email?.message}>
                  {(id) => <TextInput id={id} type="email" {...profileForm.register('email')} />}
                </Field>
                <Field label="Phone" error={profileForm.formState.errors.phone?.message}>
                  {(id) => <TextInput id={id} {...profileForm.register('phone')} />}
                </Field>
                <Field label="Timezone" hint="Used for reminders and receipts">
                  {(id) => (
                    <Select id={id} {...profileForm.register('timezone')}>
                      {[
                        'Asia/Kolkata',
                        'Asia/Dubai',
                        'Europe/London',
                        'Europe/Berlin',
                        'America/New_York',
                        'America/Los_Angeles',
                        'Asia/Singapore',
                        'Australia/Sydney',
                      ].map((tz) => (
                        <option key={tz} value={tz}>{tz}</option>
                      ))}
                    </Select>
                  )}
                </Field>
                <div className="sm:col-span-2">
                  <Button type="submit" variant="primary" loading={savingProfile} disabled={!profileForm.formState.isDirty}>
                    Save profile
                  </Button>
                </div>
              </form>
              <p className="mt-3 border-t pt-2 text-[10.5px] text-faint">
                Role: <Badge tone="muted">{profile?.role}</Badge> · Account changes and sign-in are managed in{' '}
                <a href={isAdmin ? '#/admin/security' : '#/portal/settings'} className="text-magenta hover:underline">
                  Account &amp; Security
                </a>
                .
              </p>
            </section>
          )}

          {section === 'appearance' && (
            <section className="surface p-5">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                <Palette className="h-4 w-4 text-faint" aria-hidden /> Appearance
              </h2>
              <p className="mt-1.5 text-[11.5px] text-muted">Dark is the designed default. Light mode is a real theme, not an inverted filter.</p>
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                {[
                  { value: 'dark', label: 'Dark', icon: <Moon className="h-4 w-4" /> },
                  { value: 'light', label: 'Light', icon: <Sun className="h-4 w-4" /> },
                  { value: 'system', label: 'System', icon: <Palette className="h-4 w-4" /> },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setChoice(option.value as 'dark' | 'light' | 'system')}
                    aria-pressed={choice === option.value}
                    className={cn(
                      'flex items-center gap-2 rounded-xl border p-3 text-left text-[12.5px] transition',
                      choice === option.value ? 'border-magenta/50 bg-magenta/[0.06] text-fg' : 'text-muted hover:border-[rgb(var(--line)/0.28)] hover:text-fg',
                    )}
                    style={choice === option.value ? undefined : { borderColor: 'rgb(var(--line) / 0.14)' }}
                  >
                    {option.icon}
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="mt-4 text-[10.5px] leading-relaxed text-faint">
                Animations respect your operating system’s “reduce motion” setting automatically — including the 3D scene
                on the sign-in screen.
              </p>
            </section>
          )}

          {section === 'branding' && isAdmin && (
            <section className="surface p-5">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                <Building2 className="h-4 w-4 text-faint" aria-hidden /> Branding
              </h2>
              {brandingLoading ? (
                <SkeletonRows rows={3} />
              ) : !branding ? (
                <p className="mt-3 text-[11.5px] text-muted">
                  No branding row exists yet. Run the migration that seeds <code className="font-mono">branding_settings</code>.
                </p>
              ) : (
                <>
                  <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border p-3" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
                    <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border bg-raised" style={{ borderColor: 'rgb(var(--line) / 0.18)' }}>
                      {branding.logo_url ? (
                        <img src={branding.logo_url} alt="Current logo" className="h-full w-full object-contain p-1.5" />
                      ) : (
                        <ImageIcon className="h-5 w-5 text-faint" aria-hidden />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] font-medium text-fg">{branding.logo_url ? 'Logo uploaded' : 'No logo uploaded'}</p>
                      <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted">
                        Upload your real “Managed by Luna” logo — PNG or SVG, under 2 MB. It appears on receipts and in the
                        app header. LunaDesk never redraws or approximates your logo.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/png,image/svg+xml,image/jpeg,image/webp"
                        className="sr-only"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void uploadLogo(file);
                          e.target.value = '';
                        }}
                      />
                      <Button variant="ghost" onClick={() => fileRef.current?.click()} loading={uploading} icon={<Upload className="h-3.5 w-3.5" />}>
                        Upload logo
                      </Button>
                      {branding.logo_url && (
                        <Button
                          variant="quiet"
                          onClick={async () => {
                            await adapter.update<BrandingSettings>('branding_settings', branding.id, { logo_url: null });
                            refreshBranding();
                            invalidate();
                            toast.success('Logo removed');
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>

                  <form onSubmit={saveBranding} className="mt-4 grid gap-4 sm:grid-cols-2" noValidate>
                    <Field label="Company name" error={brandingForm.formState.errors.company_name?.message} required>
                      {(id) => <TextInput id={id} {...brandingForm.register('company_name')} />}
                    </Field>
                    <Field label="Contact email" error={brandingForm.formState.errors.contact_email?.message} required>
                      {(id) => <TextInput id={id} type="email" {...brandingForm.register('contact_email')} />}
                    </Field>
                    <Field label="Contact phone">
                      {(id) => <TextInput id={id} {...brandingForm.register('contact_phone')} />}
                    </Field>
                    <Field label="Address" hint="Optional. Printed on receipts.">
                      {(id) => <TextInput id={id} {...brandingForm.register('address')} />}
                    </Field>
                    <Field label="Tax label" hint="For example GSTIN. Leave blank until you have a verified number.">
                      {(id) => <TextInput id={id} {...brandingForm.register('tax_label')} placeholder="GSTIN" />}
                    </Field>
                    <Field label="Tax ID">
                      {(id) => <TextInput id={id} {...brandingForm.register('tax_id')} placeholder="Leave blank if not applicable" />}
                    </Field>
                    <div className="sm:col-span-2">
                      <Field label="Receipt footer" hint="Printed at the bottom of every receipt." error={brandingForm.formState.errors.receipt_footer?.message}>
                        {(id) => <TextArea id={id} {...brandingForm.register('receipt_footer')} className="min-h-[64px]" />}
                      </Field>
                    </div>
                    <div className="sm:col-span-2">
                      <Button type="submit" variant="primary" loading={savingBranding} disabled={!brandingForm.formState.isDirty}>
                        Save branding
                      </Button>
                    </div>
                  </form>
                  <p className="mt-3 text-[10.5px] leading-relaxed text-faint">
                    LunaDesk will not invent a GSTIN, registered address or legal entity. Enter only verified information.
                  </p>
                </>
              )}
            </section>
          )}

          {section === 'notifications' && (
            <section className="surface p-5">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                <Bell className="h-4 w-4 text-faint" aria-hidden /> Notifications & alarm
              </h2>
              {prefsLoading ? (
                <SkeletonRows rows={3} />
              ) : (
                <div className="mt-4 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
                    <div className="min-w-0">
                      <p className="text-[12.5px] font-medium text-fg">Browser notifications</p>
                      <p className="mt-0.5 text-[10.5px] text-muted">
                        {permission === 'granted'
                          ? 'Allowed. Alerts appear even when the tab is in the background.'
                          : permission === 'denied'
                            ? 'Blocked in your browser settings. Re-enable LunaDesk there — we will not prompt again.'
                            : permission === 'unsupported'
                              ? 'Not supported in this browser. The in-app alarm and overlay still work.'
                              : 'LunaDesk only asks when you press the button.'}
                      </p>
                    </div>
                    {permission === 'granted' ? (
                      <Button size="sm" variant="quiet" onClick={() => showNotification('Test notification', { body: 'This is what a due reminder looks like.' })}>
                        Send test
                      </Button>
                    ) : permission === 'unsupported' ? (
                      <Badge tone="muted">Unsupported</Badge>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => void enableBrowserNotifications()}>
                        Allow notifications
                      </Button>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-xl border p-3" style={{ borderColor: 'rgb(var(--line) / 0.14)' }}>
                    <div>
                      <p className="text-[12.5px] font-medium text-fg">Alarm sound</p>
                      <p className="mt-0.5 text-[10.5px] text-muted">Plays with reminders that have an alarm enabled.</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={prefs?.alarm_sound ?? true}
                      aria-label="Alarm sound"
                      onClick={() => void updatePrefs({ alarm_sound: !(prefs?.alarm_sound ?? true) })}
                      className={cn(
                        'relative h-5 w-9 shrink-0 rounded-full border transition',
                        (prefs?.alarm_sound ?? true) ? 'border-magenta/50 bg-magenta/60' : 'border-[rgb(var(--line)/0.25)] bg-[rgb(var(--line)/0.1)]',
                      )}
                    >
                      <span className={cn('absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all', (prefs?.alarm_sound ?? true) ? 'left-[1.15rem]' : 'left-0.5')} />
                    </button>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={`Alarm volume — ${Math.round((prefs?.alarm_volume ?? 0.6) * 100)}%`}>
                      {(id) => (
                        <input
                          id={id}
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round((prefs?.alarm_volume ?? 0.6) * 100)}
                          onChange={(e) => {
                            const v = Number(e.target.value) / 100;
                            alarmPlayer.setVolume(v);
                            void updatePrefs({ alarm_volume: v });
                          }}
                          className="w-full accent-[#FF2D95]"
                        />
                      )}
                    </Field>
                    <Field label="Alarm tone">
                      {(id) => (
                        <Select id={id} value={prefs?.alarm_sound_name ?? 'pulse'} onChange={(e) => void updatePrefs({ alarm_sound_name: e.target.value })}>
                          <option value="pulse">Pulse</option>
                          <option value="chime">Chime</option>
                          <option value="beacon">Beacon</option>
                        </Select>
                      )}
                    </Field>
                  </div>

                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" icon={<Volume2 className="h-3.5 w-3.5" />} onClick={() => void alarmPlayer.testPlay((prefs?.alarm_sound_name as AlarmTone) ?? 'pulse', prefs?.alarm_volume ?? 0.6)}>
                      Play test alarm
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => alarmPlayer.stop()}>
                      Stop
                    </Button>
                  </div>

                  <p className="rounded-lg border border-butter/25 bg-butter/[0.06] p-2.5 text-[10.5px] leading-relaxed text-accent-butter">
                    Reminders ring while LunaDesk is open — including background and minimised tabs, delayed only by browser
                    throttling. A closed browser cannot ring; missed reminders are shown as missed on return.
                  </p>
                </div>
              )}
            </section>
          )}

          {section === 'receipts' && isAdmin && (
            <section className="surface p-5">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                <ReceiptText className="h-4 w-4 text-faint" aria-hidden /> Receipt & invoice defaults
              </h2>
              {brandingLoading || !branding ? (
                <SkeletonRows rows={2} />
              ) : (
                <form onSubmit={saveBranding} className="mt-4 grid gap-4 sm:grid-cols-2" noValidate>
                  <Field label="Receipt prefix" hint="e.g. MBL-RCP → MBL-RCP-2026-0001">
                    {(id) => <TextInput id={id} {...brandingForm.register('receipt_prefix')} className="font-mono uppercase" />}
                  </Field>
                  <Field label="Invoice prefix">
                    {(id) => <TextInput id={id} {...brandingForm.register('invoice_prefix')} className="font-mono uppercase" />}
                  </Field>
                  <Field label="Currency" hint="INR is the only supported currency in this build.">
                    {(id) => <TextInput id={id} value="INR — Indian Rupee (paise stored as integers)" readOnly className="opacity-70" />}
                  </Field>
                  <Field label="Company timezone">
                    {(id) => <TextInput id={id} value={branding.timezone} readOnly className="opacity-70" />}
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="Receipt footer" error={brandingForm.formState.errors.receipt_footer?.message}>
                      {(id) => <TextArea id={id} {...brandingForm.register('receipt_footer')} className="min-h-[64px]" />}
                    </Field>
                  </div>
                  <div className="sm:col-span-2">
                    <Button type="submit" variant="primary" loading={savingBranding} disabled={!brandingForm.formState.isDirty}>
                      Save receipt settings
                    </Button>
                  </div>
                </form>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
