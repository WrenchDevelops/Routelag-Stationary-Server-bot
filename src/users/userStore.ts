import type { SupabaseRuntime } from "../supabase.js";
import {
  defaultCloudPreferences,
  defaultCloudProfile,
  type CloudAppPreferences,
  type CloudConnections,
  type CloudTesterProfile,
  type CloudUserDocument,
} from "./types.js";

interface PathgenUserRow {
  tester_id: string;
  invite_code: string;
  clerk_user_id: string | null;
  clerk_email: string | null;
  profile: unknown;
  preferences: unknown;
  connections: unknown;
  billing_snapshot: unknown;
  epic_account_id: string | null;
  epic_display_name: string | null;
  epic_linked_at: string | null;
  discord_user_id: string | null;
  discord_username: string | null;
  discord_linked_at: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string;
  deleted_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asProfile(value: unknown): CloudTesterProfile {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<CloudTesterProfile>;
  return { ...defaultCloudProfile(), ...raw };
}

function asPreferences(value: unknown): CloudAppPreferences {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<CloudAppPreferences>;
  return { ...defaultCloudPreferences(), ...raw };
}

function asConnections(value: unknown): CloudConnections {
  return (value && typeof value === "object" ? value : {}) as CloudConnections;
}

function asBilling(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
}

function rowToUser(row: PathgenUserRow, inviteFallback = ""): CloudUserDocument {
  return {
    testerId: row.tester_id,
    inviteCode: row.invite_code || inviteFallback,
    clerkUserId: row.clerk_user_id ?? undefined,
    clerkEmail: row.clerk_email ?? undefined,
    profile: asProfile(row.profile),
    preferences: asPreferences(row.preferences),
    connections: asConnections(row.connections),
    billingSnapshot: asBilling(row.billing_snapshot),
    epicAccountId: row.epic_account_id ?? undefined,
    epicDisplayName: row.epic_display_name ?? undefined,
    epicLinkedAt: row.epic_linked_at ?? undefined,
    discordUserId: row.discord_user_id ?? undefined,
    discordUsername: row.discord_username ?? undefined,
    discordLinkedAt: row.discord_linked_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

export class UserStore {
  constructor(private readonly supabase: SupabaseRuntime) {}

  get enabled(): boolean {
    return Boolean(this.supabase.enabled && this.supabase.client);
  }

  get clientOrNull() {
    return this.supabase.client;
  }

  private client() {
    if (!this.supabase.client) {
      throw new Error("Supabase is not configured on this PathGen server.");
    }
    return this.supabase.client;
  }

  async ensureUser(
    testerId: string,
    inviteCode: string,
    identity?: { clerkUserId?: string; clerkEmail?: string },
  ): Promise<CloudUserDocument> {
    const existing = await this.getUser(testerId);
    const stamp = nowIso();
    if (!existing) {
      const { data, error } = await this.client()
        .from("pathgen_users")
        .insert({
          tester_id: testerId,
          invite_code: inviteCode,
          clerk_user_id: identity?.clerkUserId ?? null,
          clerk_email: identity?.clerkEmail ?? null,
          profile: defaultCloudProfile(),
          preferences: defaultCloudPreferences(),
          connections: {},
          billing_snapshot: {},
          created_at: stamp,
          updated_at: stamp,
          last_login_at: stamp,
        })
        .select("*")
        .single();
      if (error) throw new Error(`Supabase ensureUser insert failed: ${error.message}`);
      return rowToUser(data as PathgenUserRow, inviteCode);
    }

    const patch: Record<string, unknown> = {
      invite_code: inviteCode || existing.inviteCode,
      last_login_at: stamp,
      updated_at: stamp,
    };
    if (identity?.clerkUserId) patch.clerk_user_id = identity.clerkUserId;
    if (identity?.clerkEmail) patch.clerk_email = identity.clerkEmail;

    const { data, error } = await this.client()
      .from("pathgen_users")
      .update(patch)
      .eq("tester_id", testerId)
      .select("*")
      .single();
    if (error) throw new Error(`Supabase ensureUser update failed: ${error.message}`);
    return rowToUser(data as PathgenUserRow, inviteCode);
  }

  async getUser(testerId: string): Promise<CloudUserDocument | null> {
    const { data, error } = await this.client()
      .from("pathgen_users")
      .select("*")
      .eq("tester_id", testerId)
      .maybeSingle();
    if (error) throw new Error(`Supabase getUser failed: ${error.message}`);
    if (!data) return null;
    return rowToUser(data as PathgenUserRow);
  }

  async getUserByClerkId(clerkUserId: string): Promise<CloudUserDocument | null> {
    const { data, error } = await this.client()
      .from("pathgen_users")
      .select("*")
      .eq("clerk_user_id", clerkUserId)
      .maybeSingle();
    if (error) throw new Error(`Supabase getUserByClerkId failed: ${error.message}`);
    if (!data) return null;
    return rowToUser(data as PathgenUserRow);
  }

  async upsertProfile(
    testerId: string,
    inviteCode: string,
    profile: Partial<CloudTesterProfile>,
  ): Promise<CloudUserDocument> {
    const existing = (await this.getUser(testerId)) ?? (await this.ensureUser(testerId, inviteCode));
    const nextProfile = { ...existing.profile, ...profile };
    const stamp = nowIso();
    const { data, error } = await this.client()
      .from("pathgen_users")
      .update({
        invite_code: inviteCode || existing.inviteCode,
        profile: nextProfile,
        updated_at: stamp,
      })
      .eq("tester_id", testerId)
      .select("*")
      .single();
    if (error) throw new Error(`Supabase upsertProfile failed: ${error.message}`);
    return rowToUser(data as PathgenUserRow, inviteCode);
  }

  async upsertPreferences(
    testerId: string,
    inviteCode: string,
    preferences: Partial<CloudAppPreferences>,
  ): Promise<CloudUserDocument> {
    const existing = (await this.getUser(testerId)) ?? (await this.ensureUser(testerId, inviteCode));
    const nextPreferences = { ...existing.preferences, ...preferences };
    const stamp = nowIso();
    const { data, error } = await this.client()
      .from("pathgen_users")
      .update({
        invite_code: inviteCode || existing.inviteCode,
        preferences: nextPreferences,
        updated_at: stamp,
      })
      .eq("tester_id", testerId)
      .select("*")
      .single();
    if (error) throw new Error(`Supabase upsertPreferences failed: ${error.message}`);
    return rowToUser(data as PathgenUserRow, inviteCode);
  }

  async upsertIdentity(
    testerId: string,
    inviteCode: string,
    identity: {
      clerkUserId?: string;
      clerkEmail?: string;
      connections?: CloudConnections;
      billingSnapshot?: Record<string, unknown>;
    },
  ): Promise<CloudUserDocument> {
    const existing = (await this.getUser(testerId)) ?? (await this.ensureUser(testerId, inviteCode, identity));
    const stamp = nowIso();
    const { data, error } = await this.client()
      .from("pathgen_users")
      .update({
        clerk_user_id: identity.clerkUserId ?? existing.clerkUserId ?? null,
        clerk_email: identity.clerkEmail ?? existing.clerkEmail ?? null,
        connections: identity.connections
          ? { ...(existing.connections ?? {}), ...identity.connections }
          : (existing.connections ?? {}),
        billing_snapshot: identity.billingSnapshot ?? existing.billingSnapshot ?? {},
        updated_at: stamp,
        last_login_at: stamp,
      })
      .eq("tester_id", testerId)
      .select("*")
      .single();
    if (error) throw new Error(`Supabase upsertIdentity failed: ${error.message}`);
    return rowToUser(data as PathgenUserRow, inviteCode);
  }

  async touchLogin(testerId: string, inviteCode: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.ensureUser(testerId, inviteCode);
    } catch (error) {
      console.warn("[Supabase] Failed to touch user login:", error);
    }
  }

  async linkEpicAccount(
    testerId: string,
    inviteCode: string,
    epic: { epicAccountId: string; epicDisplayName: string },
  ): Promise<CloudUserDocument> {
    await this.ensureUser(testerId, inviteCode);
    const stamp = nowIso();
    const existing = await this.getUser(testerId);
    const connections: CloudConnections = {
      ...(existing?.connections ?? {}),
      epic: {
        connected: true,
        accountId: epic.epicAccountId,
        displayName: epic.epicDisplayName,
        linkedAt: stamp,
      },
    };
    const { data, error } = await this.client()
      .from("pathgen_users")
      .update({
        invite_code: inviteCode,
        epic_account_id: epic.epicAccountId,
        epic_display_name: epic.epicDisplayName,
        epic_linked_at: stamp,
        connections,
        updated_at: stamp,
      })
      .eq("tester_id", testerId)
      .select("*")
      .single();
    if (error) throw new Error(`Supabase linkEpicAccount failed: ${error.message}`);
    return rowToUser(data as PathgenUserRow, inviteCode);
  }

  async unlinkEpicAccount(testerId: string, inviteCode: string): Promise<CloudUserDocument> {
    await this.ensureUser(testerId, inviteCode);
    const stamp = nowIso();
    const existing = await this.getUser(testerId);
    const connections: CloudConnections = {
      ...(existing?.connections ?? {}),
      epic: { connected: false },
    };
    const { data, error } = await this.client()
      .from("pathgen_users")
      .update({
        epic_account_id: null,
        epic_display_name: null,
        epic_linked_at: null,
        connections,
        updated_at: stamp,
      })
      .eq("tester_id", testerId)
      .select("*")
      .single();
    if (error) throw new Error(`Supabase unlinkEpicAccount failed: ${error.message}`);
    return rowToUser(data as PathgenUserRow, inviteCode);
  }

  async linkDiscordAccount(
    testerId: string,
    inviteCode: string,
    discord: { discordUserId: string; discordUsername: string },
  ): Promise<CloudUserDocument> {
    await this.ensureUser(testerId, inviteCode);
    const stamp = nowIso();
    const existing = await this.getUser(testerId);
    const connections: CloudConnections = {
      ...(existing?.connections ?? {}),
      discord: {
        connected: true,
        userId: discord.discordUserId,
        tag: discord.discordUsername,
        username: discord.discordUsername,
        linkedAt: stamp,
      },
    };
    const { data, error } = await this.client()
      .from("pathgen_users")
      .update({
        invite_code: inviteCode,
        discord_user_id: discord.discordUserId,
        discord_username: discord.discordUsername,
        discord_linked_at: stamp,
        connections,
        profile: {
          ...(existing?.profile ?? defaultCloudProfile()),
          discord_username: discord.discordUsername,
        },
        updated_at: stamp,
      })
      .eq("tester_id", testerId)
      .select("*")
      .single();
    if (error) throw new Error(`Supabase linkDiscordAccount failed: ${error.message}`);
    return rowToUser(data as PathgenUserRow, inviteCode);
  }

  async unlinkDiscordAccount(testerId: string, inviteCode: string): Promise<CloudUserDocument> {
    await this.ensureUser(testerId, inviteCode);
    const stamp = nowIso();
    const existing = await this.getUser(testerId);
    const connections: CloudConnections = {
      ...(existing?.connections ?? {}),
      discord: { connected: false },
    };
    const { data, error } = await this.client()
      .from("pathgen_users")
      .update({
        discord_user_id: null,
        discord_username: null,
        discord_linked_at: null,
        connections,
        updated_at: stamp,
      })
      .eq("tester_id", testerId)
      .select("*")
      .single();
    if (error) throw new Error(`Supabase unlinkDiscordAccount failed: ${error.message}`);
    return rowToUser(data as PathgenUserRow, inviteCode);
  }

  async saveEpicOAuthState(
    state: string,
    payload: { testerId: string; inviteCode: string; expiresAt: number },
  ): Promise<void> {
    const { error } = await this.client().from("pathgen_epic_oauth_states").upsert({
      state,
      tester_id: payload.testerId,
      invite_code: payload.inviteCode,
      expires_at: new Date(payload.expiresAt).toISOString(),
      created_at: nowIso(),
    });
    if (error) throw new Error(`Supabase saveEpicOAuthState failed: ${error.message}`);
  }

  async consumeEpicOAuthState(
    state: string,
  ): Promise<{ testerId: string; inviteCode: string } | null> {
    const { data, error } = await this.client()
      .from("pathgen_epic_oauth_states")
      .select("*")
      .eq("state", state)
      .maybeSingle();
    if (error) throw new Error(`Supabase consumeEpicOAuthState failed: ${error.message}`);
    if (!data) return null;

    await this.client().from("pathgen_epic_oauth_states").delete().eq("state", state);

    const expiresAt = Date.parse(String((data as { expires_at?: string }).expires_at ?? ""));
    const testerId = String((data as { tester_id?: string }).tester_id ?? "");
    if (!testerId || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
    return {
      testerId,
      inviteCode: String((data as { invite_code?: string }).invite_code ?? ""),
    };
  }

  async saveDiscordOAuthState(
    state: string,
    payload: { testerId: string; inviteCode: string; expiresAt: number },
  ): Promise<void> {
    const { error } = await this.client().from("pathgen_discord_oauth_states").upsert({
      state,
      tester_id: payload.testerId,
      invite_code: payload.inviteCode,
      expires_at: new Date(payload.expiresAt).toISOString(),
      created_at: nowIso(),
    });
    if (error) throw new Error(`Supabase saveDiscordOAuthState failed: ${error.message}`);
  }

  async consumeDiscordOAuthState(
    state: string,
  ): Promise<{ testerId: string; inviteCode: string } | null> {
    const { data, error } = await this.client()
      .from("pathgen_discord_oauth_states")
      .select("*")
      .eq("state", state)
      .maybeSingle();
    if (error) throw new Error(`Supabase consumeDiscordOAuthState failed: ${error.message}`);
    if (!data) return null;

    await this.client().from("pathgen_discord_oauth_states").delete().eq("state", state);

    const expiresAt = Date.parse(String((data as { expires_at?: string }).expires_at ?? ""));
    const testerId = String((data as { tester_id?: string }).tester_id ?? "");
    if (!testerId || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
    return {
      testerId,
      inviteCode: String((data as { invite_code?: string }).invite_code ?? ""),
    };
  }

  async deleteUser(testerId: string): Promise<void> {
    const { error } = await this.client()
      .from("pathgen_users")
      .update({
        deleted_at: nowIso(),
        updated_at: nowIso(),
      })
      .eq("tester_id", testerId);
    if (error) throw new Error(`Supabase deleteUser failed: ${error.message}`);
  }
}
