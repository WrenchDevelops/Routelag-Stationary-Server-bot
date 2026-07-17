import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applicationDefault, cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

export interface FirebaseRuntime {
  enabled: boolean;
  projectId: string | null;
  app: App | null;
  db: Firestore | null;
}

let runtime: FirebaseRuntime | null = null;

function resolveCredentialPath(configuredPath: string): string | null {
  const candidates: string[] = [];
  if (configuredPath.trim()) {
    candidates.push(configuredPath, resolve(process.cwd(), configuredPath));
  }
  candidates.push(resolve(process.cwd(), "secrets/firebase-adminsdk.json"));
  // import.meta.dirname is Node 20.11+; older runtimes leave it undefined.
  const moduleDir = typeof import.meta.dirname === "string" ? import.meta.dirname : null;
  if (moduleDir) {
    candidates.push(resolve(moduleDir, "../secrets/firebase-adminsdk.json"));
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizePrivateKey(value: string | undefined): string | undefined {
  if (!value) return value;
  // Railway/env JSON often stores newlines as the two-char sequence \n.
  return value.replace(/\\n/g, "\n");
}

function firestoreFor(app: App): Firestore {
  const db = getFirestore(app);
  try {
    // gRPC can hang indefinitely on some Railway/container networks; REST is reliable.
    db.settings({ preferRest: true, ignoreUndefinedProperties: true });
  } catch {
    // settings() throws if called after the first Firestore operation — ignore.
  }
  return db;
}

export function initFirebase(options: {
  projectId?: string;
  credentialsPath?: string;
  credentialsJson?: string;
  disabled?: boolean;
}): FirebaseRuntime {
  if (options.disabled) {
    runtime = { enabled: false, projectId: null, app: null, db: null };
    return runtime;
  }

  if (runtime?.enabled) return runtime;

  if (getApps().length > 0) {
    const app = getApps()[0]!;
    runtime = {
      enabled: true,
      projectId: app.options.projectId ?? options.projectId ?? null,
      app,
      db: firestoreFor(app),
    };
    return runtime;
  }

  try {
    let app: App;
    const projectId = options.projectId?.trim() || undefined;

    if (options.credentialsJson?.trim()) {
      const parsed = JSON.parse(options.credentialsJson) as {
        project_id?: string;
        client_email?: string;
        private_key?: string;
      };
      app = initializeApp({
        credential: cert({
          projectId: parsed.project_id ?? projectId,
          clientEmail: parsed.client_email,
          privateKey: normalizePrivateKey(parsed.private_key),
        }),
        projectId: parsed.project_id ?? projectId,
      });
    } else {
      const credentialPath = resolveCredentialPath(options.credentialsPath ?? "");
      if (credentialPath) {
        const raw = JSON.parse(readFileSync(credentialPath, "utf8")) as {
          project_id?: string;
        };
        app = initializeApp({
          credential: cert(credentialPath),
          projectId: raw.project_id ?? projectId,
        });
      } else if (projectId) {
        app = initializeApp({
          credential: applicationDefault(),
          projectId,
        });
      } else {
        runtime = { enabled: false, projectId: null, app: null, db: null };
        return runtime;
      }
    }

    runtime = {
      enabled: true,
      projectId: app.options.projectId ?? projectId ?? null,
      app,
      db: firestoreFor(app),
    };
    return runtime;
  } catch (error) {
    console.warn("[Firebase] Failed to initialize Admin SDK:", error);
    runtime = { enabled: false, projectId: null, app: null, db: null };
    return runtime;
  }
}

export function getFirebase(): FirebaseRuntime {
  if (!runtime) {
    return initFirebase({});
  }
  return runtime;
}

/** Test helper — clears cached runtime between unit tests. */
export function resetFirebaseForTests() {
  runtime = null;
}
