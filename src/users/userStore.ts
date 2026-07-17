import type { SupabaseRuntime } from "../supabase.js";
import {
  defaultCloudPreferences,
  defaultCloudProfile,
  type CloudAppPreferences,
  type CloudTesterProfile,
  type CloudUserDocument,
} from "./types.js";

interface PathgenUserRow {
  tester_id: string;
  invite_code: string;
  profile: unknown;
  preferences: unknown;
  epic_account_id: string | null;
  epic_display_name: string | null;
  epic_linked_at: string | null;
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

function rowToUser(row: PathgenUserRow, inviteFallback = ""): CloudUserDocument {
  return {
    testerId: row.tester_id,
    inviteCode: row.invite_code || inviteFallback,
    profile: asProfile(row.profile),
    preferences: asPreferences(row.preferences),
    epicAccountId: row.epic_account_id ?? undefined,
    epicDisplayName: row.epic_display_name ?? undefined,
    epicLinkedAt: row.epic_linked_at ?? undefined,
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

  private client() {
    if (!this.supabase.client) {
      throw new Error("Supabase is not configured on this PathGen server.");
    }
    return this.supabase.client;
  }

  async ensureUser(testerId: string, inviteCode: string): Promise<CloudUserDocument> {
    const existing = await this.getUser(testerId);
    const stamp = nowIso();
    if (!existing) {
      const { data, error } = await this.client()
        .from("pathgen_users")
        .insert({
          tester_id: testerId,
          invite_code: inviteCode,
          profile: defaultCloudProfile(),
          preferences: defaultCloudPreferences(),
          created_at: stamp,
          updated_at: stamp,
          last_login_at: stamp,
        })
        .select("*")
        .single();
      if (error) throw new Error(`Supabase ensureUser insert failed: ${error.message}`);
      return rowToUser(data as PathgenUserRow, inviteCode);
    }

    const { data, error } = await this.client()
      .from("pathgen_users")
      .update({
        invite_code: inviteCode || existing.inviteCode,
        last_login_at: stamp,
        updated_at: stamp,
      })
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
    const { data, error } = await this.client()
      .from("pathgen_users")
      .update({
        invite_code: inviteCode,
        epic_account_id: epic.epicAccountId,
        epic_display_name: epic.epicDisplayName,
        epic_linked_at: stamp,
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
    const { data, error } = await this.client()
      .from("pathgen_users")
      .update({
        epic_account_id: null,
        epic_display_name: null,
        epic_linked_at: null,
        updated_at: stamp,
      })
      .eq("tester_id", testerId)
      .select("*")
      .single();
    if (error) throw new Error(`Supabase unlinkEpicAccount failed: ${error.message}`);
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
