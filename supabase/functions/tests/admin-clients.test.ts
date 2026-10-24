/**
 * Executed tests for the admin-clients Edge Function.
 *
 *   deno test --allow-env supabase/functions/tests/
 *
 * These run the real handler with fake Supabase clients, so the questions that
 * matter for a failed provisioning are answered by running the code, not by
 * reading it:
 *
 *   * an account this request created is deleted again;
 *   * an account that already existed is never touched;
 *   * losing a creation race does not make someone else's account "ours";
 *   * a failed cleanup leaves a recovery reference and logs no secrets.
 *
 * The Edge Function itself never ran on Supabase's runtime here (no project),
 * but this is the handler, unchanged, executed in Deno.
 */
import { makeHandler } from '../admin-clients/handler.ts';

const CLIENT_ID = '11111111-2222-4333-8444-555555555555';
const CODE = 'RACE1CODE';
const EXISTING_USER = '99999999-9999-4999-8999-999999999999';
const NEW_USER = '88888888-8888-4888-8888-888888888888';

interface FakeOptions {
  /** Users listUsers() should return on the first lookup. */
  existingEmail?: string;
  /** Result of auth.admin.createUser(). */
  create?: 'ok' | 'conflict';
  /** Turn the avatar-admins listUsers() into a failure. */
  listError?: string;
  /** Result of auth.admin.deleteUser(). */
  deleteUser?: 'ok' | 'fail';
  /** Error returned by the portal RPC. */
  rpcError?: string | null;
}

function makeFakes(options: FakeOptions = {}) {
  const calls = {
    created: 0,
    deleted: [] as string[],
    rpc: [] as string[],
    logs: [] as string[],
  };

  const originalError = console.error;
  const originalWarn = console.warn;
  const capture = (label: string) => (...args: unknown[]) => {
    calls.logs.push(`${label} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  };

  const service = {
    from(_table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return {
                    data: { id: CLIENT_ID, client_code: 'RACE01', business_name: 'Race Client', email: null, portal_status: 'none' },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
    auth: {
      admin: {
        async listUsers() {
          // First lookup sees only pre-existing accounts; after a creation
          // conflict it sees the winner's account too.
          const users = options.existingEmail
            ? [{ id: EXISTING_USER, email: options.existingEmail }]
            : calls.created > 0
              ? [{ id: NEW_USER, email: 'portal.race01@clients.managedbyluna.com' }]
              : [];
          return { data: { users }, error: options.listError ? { message: options.listError } : null };
        },
        async createUser() {
          calls.created += 1;
          if (options.create === 'conflict') {
            return { data: { user: null }, error: { message: 'User already registered' } };
          }
          return { data: { user: { id: NEW_USER } }, error: null };
        },
        async deleteUser(id: string) {
          calls.deleted.push(id);
          return { data: null, error: options.deleteUser === 'fail' ? { message: 'delete failed' } : null };
        },
      },
    },
  };

  const user = {
    async rpc(name: string) {
      calls.rpc.push(name);
      return { data: null, error: options.rpcError ? { message: options.rpcError } : null };
    },
  };

  console.error = capture('error');
  console.warn = capture('warn');

  const handler = makeHandler({
    requireAdmin: async () => ({ id: 'admin-1', email: 'admin@example.test', isAdmin: true, token: 'jwt' }),
    serviceClient: () => service,
    userClient: () => user,
  });

  const restore = () => {
    console.error = originalError;
    console.warn = originalWarn;
  };

  return { handler, calls, restore };
}

function request(body: Record<string, unknown>): Request {
  return new Request('https://example.test/functions/v1/admin-clients', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.example.test' },
    body: JSON.stringify(body),
  });
}

const CREATE_BODY = { action: 'create_portal', client_id: CLIENT_ID, code: CODE };

function assertNoSecrets(logs: string[]) {
  const joined = logs.join('\n');
  if (joined.includes(CODE)) throw new Error(`the access code appeared in the logs:\n${joined}`);
  if (/portal\.race01@/i.test(joined)) throw new Error(`an email address appeared in the logs:\n${joined}`);
  if (/password|token=|bearer/i.test(joined)) throw new Error(`something credential-shaped appeared in the logs:\n${joined}`);
}

Deno.test('a new account is deleted again when provisioning fails', async () => {
  const { handler, calls, restore } = makeFakes({ rpcError: 'boom' });
  try {
    const res = await handler(request(CREATE_BODY));
    const body = await res.json();

    assertEquals(res.status, 500);
    assertEquals(calls.created, 1);
    assertEquals(calls.deleted, [NEW_USER]);
    assertEquals(body.orphan_removed, true);
    assertEquals(body.user_created_here, true);
    assertEquals(body.recovery_reference, null);
    assertNoSecrets(calls.logs);
  } finally {
    restore();
  }
});

Deno.test('a pre-existing account is never deleted', async () => {
  const { handler, calls, restore } = makeFakes({
    existingEmail: 'portal.race01@clients.managedbyluna.com',
    rpcError: 'boom',
  });
  try {
    const res = await handler(request(CREATE_BODY));
    const body = await res.json();

    assertEquals(res.status, 500);
    assertEquals(calls.created, 0, 'no account should have been created');
    assertEquals(calls.deleted, [], 'a pre-existing account must not be deleted');
    assertEquals(body.user_created_here, false);
    assertEquals(body.orphan_removed, false);
    if (!String(body.message).includes('existing account was left untouched')) {
      throw new Error(`unexpected message: ${body.message}`);
    }
    assertNoSecrets(calls.logs);
  } finally {
    restore();
  }
});

Deno.test('losing a creation race does not make the winner\'s account ours', async () => {
  const { handler, calls, restore } = makeFakes({ create: 'conflict', rpcError: 'boom' });
  try {
    const res = await handler(request(CREATE_BODY));
    const body = await res.json();

    assertEquals(res.status, 500);
    assertEquals(calls.created, 1, 'a creation was attempted');
    assertEquals(calls.deleted, [], 'the account the race resolved to was not created here');
    assertEquals(body.user_created_here, false);
    assertNoSecrets(calls.logs);
  } finally {
    restore();
  }
});

Deno.test('a failed cleanup logs a recovery reference and no secrets', async () => {
  const { handler, calls, restore } = makeFakes({ rpcError: 'boom', deleteUser: 'fail' });
  try {
    const res = await handler(request(CREATE_BODY));
    const body = await res.json();

    assertEquals(res.status, 500);
    assertEquals(calls.deleted, [NEW_USER]);
    assertEquals(body.orphan_removed, false);
    assertEquals(body.recovery_reference, `portal-cleanup:${NEW_USER}`);

    const log = calls.logs.join('\n');
    if (!log.includes(`portal-cleanup:${NEW_USER}`)) {
      throw new Error(`the recovery reference was not logged:\n${log}`);
    }
    if (!log.includes(CLIENT_ID)) throw new Error(`the client id was not logged:\n${log}`);
    assertNoSecrets(calls.logs);
  } finally {
    restore();
  }
});

Deno.test('a successful provisioning deletes nothing', async () => {
  const { handler, calls, restore } = makeFakes({ rpcError: null });
  try {
    const res = await handler(request(CREATE_BODY));
    const body = await res.json();

    assertEquals(res.status, 200);
    assertEquals(body.ok, true);
    assertEquals(body.user_id, NEW_USER);
    assertEquals(calls.deleted, []);
    assertEquals(calls.rpc, ['rpc_attach_client_portal']);
    assertNoSecrets(calls.logs);
  } finally {
    restore();
  }
});

Deno.test('a lookup failure is reported, not silently treated as "no account"', async () => {
  const { handler, calls, restore } = makeFakes({ listError: 'connection reset' });
  try {
    const res = await handler(request(CREATE_BODY));
    assertEquals(res.status, 500);
    assertEquals(calls.created, 0, 'no account is created when the lookup failed');
    assertEquals(calls.deleted, []);
  } finally {
    restore();
  }
});

// deno-lint-ignore no-explicit-any
function assertEquals(actual: any, expected: any, message?: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message ? message + ': ' : ''}expected ${e}, got ${a}`);
}
