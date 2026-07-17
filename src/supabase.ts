import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseRuntime {
  enabled: boolean;
  url: string | null;
  client: SupabaseClient | null;
}

let runtime: SupabaseRuntime | null = null;

export function initSupabase(options: {
  url?: string;
  serviceRoleKey?: string;
  disabled?: boolean;
}): SupabaseRuntime {
  if (options.disabled) {
    runtime = { enabled: false, url: null, client: null };
    return runtime;
  }

  if (runtime?.enabled) return runtime;

  const url = options.url?.trim() || "";
  const serviceRoleKey = options.serviceRoleKey?.trim() || "";

  if (!url || !serviceRoleKey) {
    console.warn(
      "[Supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; cloud user sync is offline.",
    );
    runtime = { enabled: false, url: url || null, client: null };
    return runtime;
  }

  try {
    const client = createClient(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    runtime = { enabled: true, url, client };
    return runtime;
  } catch (error) {
    console.warn("[Supabase] Failed to initialize client:", error);
    runtime = { enabled: false, url, client: null };
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
