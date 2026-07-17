import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

export interface SupabaseRuntime {
  enabled: boolean;
  url: string | null;
  /** JWT `role` claim from the configured key (`service_role` expected). */
  keyRole: string | null;
  client: SupabaseClient | null;
}

let runtime: SupabaseRuntime | null = null;

export function decodeSupabaseKeyRole(apiKey: string): string | null {
  try {
    const parts = apiKey.split(".");
    if (parts.length < 2) return null;
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(json) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

export function initSupabase(options: {
  url?: string;
  serviceRoleKey?: string;
  disabled?: boolean;
}): SupabaseRuntime {
  if (options.disabled) {
    runtime = { enabled: false, url: null, keyRole: null, client: null };
    return runtime;
  }

  if (runtime?.enabled) return runtime;

  const url = options.url?.trim() || "";
  const serviceRoleKey = options.serviceRoleKey?.trim() || "";

  if (!url || !serviceRoleKey) {
    console.warn(
      "[Supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; cloud user sync is offline.",
    );
    runtime = { enabled: false, url: url || null, keyRole: null, client: null };
    return runtime;
  }

  const keyRole = decodeSupabaseKeyRole(serviceRoleKey);
  if (keyRole && keyRole !== "service_role") {
    console.warn(
      `[Supabase] SUPABASE_SERVICE_ROLE_KEY has role "${keyRole}" (expected service_role). ` +
        "Replace it with the service_role secret from Supabase → Project Settings → API.",
    );
  }

  try {
    // Railway currently runs Node 20; newer supabase-js expects a global WebSocket
    // (Node 22+) or an explicit transport. PathGen only needs PostgREST, not realtime.
    const client = createClient(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      realtime: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transport: ws as any,
      },
    });
    runtime = { enabled: true, url, keyRole, client };
    return runtime;
  } catch (error) {
    console.warn("[Supabase] Failed to initialize client:", error);
    runtime = { enabled: false, url, keyRole, client: null };
    return runtime;
  }
}

export function getSupabase(): SupabaseRuntime {
  if (!runtime) return initSupabase({});
  return runtime;
}

/** Test helper — clears cached runtime between unit tests. */
export function resetSupabaseForTests() {
  runtime = null;
}
