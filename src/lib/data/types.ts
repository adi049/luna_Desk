/**
 * Table + RPC registry. The single source of truth for what the data layer
 * may touch. Adding a table to the schema means adding it here (and to the
 * Supabase migration + RLS policies), which keeps TypeScript, the demo store
 * and the live client in agreement.
 */
export const TABLES = [
  'profiles',
  'clients',
  'services',
  'client_services',
  'projects',
  'project_updates',
  'invoices',
  'invoice_items',
  'payments',
  'receipts',
  'tasks',
  'calendar_events',
  'notes',
  'reminders',
  'notifications',
  'notification_preferences',
  'stopwatch_sessions',
  'branding_settings',
  'audit_logs',
  'announcements',
  'client_access_codes',
  'push_subscriptions',
] as const;

export type TableName = (typeof TABLES)[number];

export type RpcName =
  | 'record_payment'
  | 'void_payment'
  | 'issue_receipt'
  | 'change_client_access_code'
  | 'create_client_portal'
  | 'revoke_client_access'
  | 'refresh_invoice_status';

export type Row = Record<string, unknown>;

export interface ListOptions {
  where?: Row;
  order?: { column: string; ascending?: boolean };
  limit?: number;
  /** Columns to select. Defaults to '*'. */
  select?: string;
}

export interface DataAdapter {
  readonly mode: 'live' | 'demo';
  list<T>(table: TableName, opts?: ListOptions): Promise<T[]>;
  get<T>(table: TableName, id: string): Promise<T | null>;
  insert<T>(table: TableName, row: Row): Promise<T>;
  update<T>(table: TableName, id: string, patch: Row): Promise<T>;
  remove(table: TableName, id: string): Promise<void>;
  rpc<T>(fn: RpcName, args?: Row): Promise<T>;
  /** Uploads the brand logo and returns a URL usable in receipts. */
  uploadLogo(file: File): Promise<string>;
}

export type AccessResult =
  | { ok: true; role: 'client' | 'admin'; displayName: string }
  | { ok: false; error: string; retryAfterSeconds?: number };

export interface AuthAdapter {
  readonly mode: 'live' | 'demo';
  /** Email + password, used by the dedicated admin entry. */
  signInWithPassword(email: string, password: string): Promise<{ ok: boolean; error?: string }>;
  /** Passwordless admin entry — Supabase sends a one-time link. */
  sendMagicLink(email: string): Promise<{ ok: boolean; error?: string }>;
  /** Client entry: exchanges a low-entropy access code for a real session. */
  signInWithAccessCode(code: string): Promise<AccessResult>;
  /** Admin codes additionally require the account password. */
  signInAdminWithCode(code: string, password: string): Promise<AccessResult>;
  signOut(): Promise<void>;
  /** Resolves the persisted session at start-up (async in live mode). */
  init(): Promise<string | null>;
  getCurrentUserId(): string | null;
  onAuthStateChange(cb: (userId: string | null) => void): () => void;
}
