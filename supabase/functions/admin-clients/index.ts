// =============================================================================
// POST /functions/v1/admin-clients
//
// Admin-only operations that need the Auth Admin API, which is impossible from
// the browser without the service key:
//
//   { action: 'create_portal', client_id, email?, code, full_name? }
//   { action: 'rotate_code',   client_id, code }
//   { action: 'revoke',        client_id, reason? }
//
// Every action re-checks the caller's admin role server-side; the request body
// is never trusted for identity.
//
// The handler itself lives in handler.ts (no Supabase imports, so it can be
// executed by supabase/functions/tests/). This file is the wiring.
// =============================================================================

import { requireAdmin, serviceClient, userClient } from '../_shared/supabase.ts';
import { makeHandler } from './handler.ts';

Deno.serve(makeHandler({ requireAdmin, serviceClient, userClient }));
