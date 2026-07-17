import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";

import type { FirebaseRuntime } from "../firebase.js";
import {
  defaultCloudPreferences,
  defaultCloudProfile,
  type CloudAppPreferences,
  type CloudTesterProfile,
  type CloudUserDocument,
} from "./types.js";

const USERS_COLLECTION = "users";

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

function normalizeUser(
  testerId: string,
  inviteCode: string,
  data: Record<string, unknown> | undefined,
): CloudUserDocument {
  const createdAt = typeof data?.createdAt === "string" ? data.createdAt : nowIso();
  const updatedAt = typeof data?.updatedAt === "string" ? data.updatedAt : createdAt;
  const lastLoginAt = typeof data?.lastLoginAt === "string" ? data.lastLoginAt : createdAt;
  return {
    testerId,
    inviteCode: typeof data?.inviteCode === "string" ? data.inviteCode : inviteCode,
    profile: asProfile(data?.profile),
    preferences: asPreferences(data?.preferences),
    epicAccountId: typeof data?.epicAccountId === "string" ? data.epicAccountId : undefined,
    epicDisplayName: typeof data?.epicDisplayName === "string" ? data.epicDisplayName : undefined,
    epicLinkedAt: typeof data?.epicLinkedAt === "string" ? data.epicLinkedAt : undefined,
    createdAt,
    updatedAt,
    lastLoginAt,
  };
}

export class UserStore {
  constructor(private readonly firebase: FirebaseRuntime) {}

  get enabled(): boolean {
    return Boolean(this.firebase.enabled && this.firebase.db);
  }

  private db(): Firestore {
    if (!this.firebase.db) {
      throw new Error("Firebase is not configured on this PathGen server.");
    }
    return this.firebase.db;
  }

  private userRef(testerId: string) {
    return this.db().collection(USERS_COLLECTION).doc(testerId);
  }

  async ensureUser(testerId: string, inviteCode: string): Promise<CloudUserDocument> {
    const ref = this.userRef(testerId);
    const snap = await ref.get();
    const stamp = nowIso();

    if (!snap.exists) {
      const doc: CloudUserDocument = {
        testerId,
        inviteCode,
        profile: defaultCloudProfile(),
        preferences: defaultCloudPreferences(),
        createdAt: stamp,
        updatedAt: stamp,
        lastLoginAt: stamp,
      };
      await ref.set(doc);
      return doc;
    }

    await ref.set(
      {
        inviteCode,
        lastLoginAt: stamp,
        updatedAt: stamp,
      },
      { merge: true },
    );
    return normalizeUser(testerId, inviteCode, {
      ...(snap.data() as Record<string, unknown> | undefined),
      inviteCode,
      lastLoginAt: stamp,
      updatedAt: stamp,
    });
  }

  async getUser(testerId: string): Promise<CloudUserDocument | null> {
    const snap = await this.userRef(testerId).get();
    if (!snap.exists) return null;
    return normalizeUser(testerId, "", snap.data() as Record<string, unknown> | undefined);
  }

  async upsertProfile(
    testerId: string,
    inviteCode: string,
    profile: Partial<CloudTesterProfile>,
  ): Promise<CloudUserDocument> {
    const existing = (await this.getUser(testerId)) ?? (await this.ensureUser(testerId, inviteCode));
    const nextProfile = { ...existing.profile, ...profile };
    const stamp = nowIso();
    await this.userRef(testerId).set(
      {
        testerId,
        inviteCode: inviteCode || existing.inviteCode,
        profile: nextProfile,
        preferences: existing.preferences,
        createdAt: existing.createdAt,
        updatedAt: stamp,
        lastLoginAt: existing.lastLoginAt,
      },
      { merge: true },
    );
    return {
      ...existing,
      inviteCode: inviteCode || existing.inviteCode,
      profile: nextProfile,
      updatedAt: stamp,
    };
  }

  async upsertPreferences(
    testerId: string,
    inviteCode: string,
    preferences: Partial<CloudAppPreferences>,
  ): Promise<CloudUserDocument> {
    const existing = (await this.getUser(testerId)) ?? (await this.ensureUser(testerId, inviteCode));
    const nextPreferences = { ...existing.preferences, ...preferences };
    const stamp = nowIso();
    await this.userRef(testerId).set(
      {
        testerId,
        inviteCode: inviteCode || existing.inviteCode,
        profile: existing.profile,
        preferences: nextPreferences,
        createdAt: existing.createdAt,
        updatedAt: stamp,
        lastLoginAt: existing.lastLoginAt,
      },
      { merge: true },
    );
    return {
      ...existing,
      inviteCode: inviteCode || existing.inviteCode,
      preferences: nextPreferences,
      updatedAt: stamp,
    };
  }

  async touchLogin(testerId: string, inviteCode: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.ensureUser(testerId, inviteCode);
    } catch (error) {
      console.warn("[Firebase] Failed to touch user login:", error);
    }
  }

  async linkEpicAccount(
    testerId: string,
    inviteCode: string,
    epic: { epicAccountId: string; epicDisplayName: string },
  ): Promise<CloudUserDocument> {
    const existing = (await this.getUser(testerId)) ?? (await this.ensureUser(testerId, inviteCode));
    const stamp = nowIso();
    await this.userRef(testerId).set(
      {
        testerId,
        inviteCode: inviteCode || existing.inviteCode,
        epicAccountId: epic.epicAccountId,
        epicDisplayName: epic.epicDisplayName,
        epicLinkedAt: stamp,
        updatedAt: stamp,
      },
      { merge: true },
    );
    return {
      ...existing,
      inviteCode: inviteCode || existing.inviteCode,
      epicAccountId: epic.epicAccountId,
      epicDisplayName: epic.epicDisplayName,
      epicLinkedAt: stamp,
      updatedAt: stamp,
    };
  }

  async unlinkEpicAccount(testerId: string, inviteCode: string): Promise<CloudUserDocument> {
    const existing = (await this.getUser(testerId)) ?? (await this.ensureUser(testerId, inviteCode));
    const stamp = nowIso();
    await this.userRef(testerId).set(
      {
        epicAccountId: FieldValue.delete(),
        epicDisplayName: FieldValue.delete(),
        epicLinkedAt: FieldValue.delete(),
        updatedAt: stamp,
      },
      { merge: true },
    );
    return {
      ...existing,
      inviteCode: inviteCode || existing.inviteCode,
      epicAccountId: undefined,
      epicDisplayName: undefined,
      epicLinkedAt: undefined,
      updatedAt: stamp,
    };
  }

  /** Soft-delete helper for future account wipe flows. */
  async deleteUser(testerId: string): Promise<void> {
    await this.userRef(testerId).set(
      {
        deletedAt: FieldValue.serverTimestamp(),
        updatedAt: nowIso(),
      },
      { merge: true },
    );
  }
}
