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

/** Keep connections JSON aligned with the authoritative OAuth columns. */
function reconcileConnections(row: PathgenUserRow): CloudConnections {
  const base = asConnections(row.connections);
  if (row.discord_user_id) {
    base.discord = {
      connected: true,
      userId: row.discord_user_id,
      tag: row.discord_username ?? base.discord?.tag ?? base.discord?.username,
      username: row.discord_username ?? base.discord?.username ?? base.discord?.tag,
      linkedAt: row.discord_linked_at ?? base.discord?.linkedAt,
    };
  } else {
    base.discord = { connected: false };
  }
  if (row.epic_account_id) {
    base.epic = {
      connected: true,
      accountId: row.epic_account_id,
      displayName: row.epic_display_name ?? base.epic?.displayName,
      linkedAt: row.epic_linked_at ?? base.epic?.linkedAt,
    };
  } else {
    base.epic = { connected: false };
  }
  return base;
}

function rowToUser(row: PathgenUserRow, inviteFallback = ""): CloudUserDocument {
  return {
    testerId: row.tester_id,
    inviteCode: row.invite_code || inviteFallback,
    clerkUserId: row.clerk_user_id ?? undefined,
    clerkEmail: row.clerk_email ?? undefined,
    profile: asProfile(row.profile),
    preferences: asPreferences(row.preferences),
    connections: reconcileConnections(row),
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

  /** Exact invite_code match only — never use email as an authorization key. */
  async getUserByInviteCodeExact(inviteCode: string): Promise<CloudUserDocument | null> {
    const value = inviteCode.trim();
    if (!value) return null;
    const { data: byInvite, error: inviteError } = await this.client()
      .from("pathgen_users")
      .select("*")
      .eq("invite_code", value)
      .maybeSingle();
    if (inviteError) throw new Error(`Supabase getUserByInvite failed: ${inviteError.message}`);
    if (!byInvite) return null;
    return rowToUser(byInvite as PathgenUserRow);
  }

  /**
   * @deprecated Prefer getUserByInviteCodeExact or getUserByClerkId.
   * Email lookup is retained for ops/manual review tooling only — never for auth.
   */
  async getUserByInviteOrEmail(inviteOrEmail: string): Promise<CloudUserDocument | null> {
    const byInvite = await this.getUserByInviteCodeExact(inviteOrEmail);
    if (byInvite) return byInvite;

    const value = inviteOrEmail.trim();
    if (!value.includes("@")) return null;
    const { data: byEmail, error: emailError } = await this.client()
      .from("pathgen_users")
      .select("*")
      .ilike("clerk_email", value)
      .maybeSingle();
    if (emailError) throw new Error(`Supabase getUserByEmail failed: ${emailError.message}`);
    if (!byEmail) return null;
    return rowToUser(byEmail as PathgenUserRow);
  }

  /** Copy Epic/Discord link fields from a legacy row onto the canonical account. */
  async mergeLinkedAccounts(fromTesterId: string, toTesterId: string): Promise<void> {
    if (!fromTesterId || fromTesterId === toTesterId) return;
    const from = await this.getUser(fromTesterId);
    if (!from) return;
    // Ensure the destination row exists before copying OAuth links onto it.
    const to =
      (await this.getUser(toTesterId)) ??
      (await this.ensureUser(toTesterId, from.inviteCode || "clerk", {
        clerkUserId: from.clerkUserId,
        clerkEmail: from.clerkEmail,
      }));

    const stamp = nowIso();
    const patch: Record<string, unknown> = { updated_at: stamp };
    const nextConnections: CloudConnections = { ...(to.connections ?? {}) };

    if (!to.epicAccountId && from.epicAccountId) {
      patch.epic_account_id = from.epicAccountId;
      patch.epic_display_name = from.epicDisplayName ?? null;
      patch.epic_linked_at = from.epicLinkedAt ?? null;
      nextConnections.epic = {
        connected: true,
        accountId: from.epicAccountId,
        displayName: from.epicDisplayName,
        linkedAt: from.epicLinkedAt,
      };
    }
    if (!to.discordUserId && from.discordUserId) {
      patch.discord_user_id = from.discordUserId;
      patch.discord_username = from.discordUsername ?? null;
      patch.discord_linked_at = from.discordLinkedAt ?? null;
      nextConnections.discord = {
        connected: true,
        userId: from.discordUserId,
        tag: from.discordUsername,
        username: from.discordUsername,
        linkedAt: from.discordLinkedAt,
      };
    }
    if (Object.keys(patch).length <= 1) return;

    patch.connections = nextConnections;
    const { error } = await this.client()
      .from("pathgen_users")
      .update(patch)
      .eq("tester_id", toTesterId);
    if (error) throw new Error(`Supabase mergeLinkedAccounts failed: ${error.message}`);
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
    const existing =
      (await this.getUser(testerId)) ?? (await this.ensureUser(testerId, inviteCode, identity));
    const stamp = nowIso();

    // Client identity sync may patch google (and similar), but Discord/Epic are
    // server-owned via OAuth columns and must not be wiped by a partial payload.
    const nextConnections: CloudConnections = {
      ...(existing.connections ?? {}),
    };
    if (identity.connections?.google) {
      nextConnections.google = identity.connections.google;
    }
    if (existing.discordUserId) {
      nextConnections.discord = {
        connected: true,
        userId: existing.discordUserId,
        tag: existing.discordUsername,
        username: existing.discordUsername,
        linkedAt: existing.discordLinkedAt,
      };
    } else if (!nextConnections.discord) {
      nextConnections.discord = { connected: false };
    }
    if (existing.epicAccountId) {
      nextConnections.epic = {
        connected: true,
        accountId: existing.epicAccountId,
        displayName: existing.epicDisplayName,
        linkedAt: existing.epicLinkedAt,
      };
    } else if (!nextConnections.epic) {
      nextConnections.epic = { connected: false };
    }

    const { data, error } = await this.client()
      .from("pathgen_users")
      .update({
        clerk_user_id: identity.clerkUserId ?? existing.clerkUserId ?? null,
        clerk_email: identity.clerkEmail ?? existing.clerkEmail ?? null,
        connections: nextConnections,
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
    await this.releaseEpicAccountId(epic.epicAccountId, testerId);
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
    if (error) {
      if (/duplicate|unique|epic_account_id/i.test(error.message)) {
        throw new Error(
          "This Epic account is already linked to another Zer0 account. Disconnect it there first, then try again.",
        );
      }
      throw new Error(`Supabase linkEpicAccount failed: ${error.message}`);
    }
    return rowToUser(data as PathgenUserRow, inviteCode);
  }

  private async releaseEpicAccountId(
    epicAccountId: string,
    keepTesterId: string,
  ): Promise<void> {
    const { data: holders, error: lookupError } = await this.client()
      .from("pathgen_users")
      .select("tester_id, connections")
      .eq("epic_account_id", epicAccountId)
      .neq("tester_id", keepTesterId);
    if (lookupError) {
      throw new Error(`Supabase releaseEpicAccountId lookup failed: ${lookupError.message}`);
    }
    if (!holders?.length) return;

    const stamp = nowIso();
    for (const holder of holders) {
      const connections: CloudConnections = {
        ...asConnections(holder.connections),
        epic: { connected: false },
      };
      const { error } = await this.client()
        .from("pathgen_users")
        .update({
          epic_account_id: null,
          epic_display_name: null,
          epic_linked_at: null,
          connections,
          updated_at: stamp,
        })
        .eq("tester_id", holder.tester_id)
        .eq("epic_account_id", epicAccountId);
      if (error) {
        throw new Error(`Supabase releaseEpicAccountId failed: ${error.message}`);
      }
    }
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
    // Unique constraint pathgen_users_discord_user_id_uidx — free the Discord ID
    // from any other tester before attaching it to this one.
    await this.releaseDiscordUserId(discord.discordUserId, testerId);
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
    if (error) {
      if (/duplicate|unique|pathgen_users_discord_user_id/i.test(error.message)) {
        throw new Error(
          "This Discord account is already linked to another Zer0 account. Disconnect it there first, then try again.",
        );
      }
      throw new Error(`Supabase linkDiscordAccount failed: ${error.message}`);
    }
    return rowToUser(data as PathgenUserRow, inviteCode);
  }

  /** Clear discord_* from every other pathgen_users row that owns this Discord ID. */
  private async releaseDiscordUserId(
    discordUserId: string,
    keepTesterId: string,
  ): Promise<void> {
    const { data: holders, error: lookupError } = await this.client()
      .from("pathgen_users")
      .select("tester_id, connections")
      .eq("discord_user_id", discordUserId)
      .neq("tester_id", keepTesterId);
    if (lookupError) {
      throw new Error(`Supabase releaseDiscordUserId lookup failed: ${lookupError.message}`);
    }
    if (!holders?.length) return;

    const stamp = nowIso();
    for (const holder of holders) {
      const connections: CloudConnections = {
        ...asConnections(holder.connections),
        discord: { connected: false },
      };
      const { error } = await this.client()
        .from("pathgen_users")
        .update({
          discord_user_id: null,
          discord_username: null,
          discord_linked_at: null,
          connections,
          updated_at: stamp,
        })
        .eq("tester_id", holder.tester_id)
        .eq("discord_user_id", discordUserId);
      if (error) {
        throw new Error(`Supabase releaseDiscordUserId failed: ${error.message}`);
      }
    }
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
