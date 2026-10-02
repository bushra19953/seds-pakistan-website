import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';

// Production-safe singleton with robust strategies (lazy init to avoid deploy analyzer timeouts)
let lastError: string | null = null;
let initMode: 'existing' | 'firebaseConfig' | 'adcWithProject' | 'serviceAccount' | 'localFile' | 'firebaseHosting' | 'default' | 'error' = 'default';
let adminDb: FirebaseFirestore.Firestore | null = null; // lazily assigned
let adminApp: admin.app.App | null = null; // cache the initialized app

function getOrInitAdminApp(): admin.app.App | null {
  try {
    // Return cached app if we have one
    if (adminApp) {
      return adminApp;
    }

    // Check if an app already exists (from previous initialization)
    if (admin.apps.length > 0) {
      try {
        const app = admin.app();
        // Verify the app is actually usable
        if (app && app.options && app.options.projectId) {
          initMode = 'existing';
          adminApp = app;
          return app;
        }
      } catch (e) {
        // Continue to initialization
      }
    }

    const projectId =
      process.env.FIREBASE_PROJECT_ID ||
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      'seds-pakistan'; // Default to your project ID

    // Strategy 0: Check for local service account file in development
    if (process.env.NODE_ENV === 'development') {
      const possibleFiles = [
        'seds-pakistan-service-account.json',
        'firebase-service-account.json'
      ];
      
      for (const fileName of possibleFiles) {
        try {
          const filePath = path.join(process.cwd(), fileName);
          if (fs.existsSync(filePath)) {
            const serviceAccount = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            // Check if it's a real service account (not the dummy one)
            if (serviceAccount.private_key && !serviceAccount.private_key.includes('local-development-key')) {
              adminApp = admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                projectId: serviceAccount.project_id || projectId
              });
              initMode = 'localFile';
              console.log(`[firebase-admin] Initialized using local file: ${fileName}`);
              return adminApp;
            }
          }
        } catch (e) {
          // Continue to next strategy
        }
      }
    }

    // Strategy 1: Use FIREBASE_SERVICE_ACCOUNT environment variable (Vercel)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        const saData = process.env.FIREBASE_SERVICE_ACCOUNT;
        let serviceAccount: any = null;

        // Try direct parse
        try {
          serviceAccount = typeof saData === 'string' ? JSON.parse(saData) : saData;
          if (typeof serviceAccount === 'string') serviceAccount = JSON.parse(serviceAccount);
        } catch (_e1) {
          // Try escaping raw newlines
          try {
            serviceAccount = JSON.parse(saData.replace(/[\r\n]+/g, '\\n'));
          } catch (_e2) {
            // Regex extraction fallback
            try {
              const project_id = (saData.match(/"project_id"\s*:\s*"([^"]+)"/) || [])[1];
              const client_email = (saData.match(/"client_email"\s*:\s*"([^"]+)"/) || [])[1];
              const private_key_match = saData.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/);
              if (project_id && client_email && private_key_match) {
                const private_key = private_key_match[0].replace(/\\n/g, '\n');
                serviceAccount = { project_id, client_email, private_key };
              }
            } catch (_e3) {}
          }
        }
        
        if (serviceAccount && typeof serviceAccount.private_key === 'string') {
          serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }

        if (serviceAccount && serviceAccount.private_key && serviceAccount.client_email) {
          adminApp = admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: serviceAccount.project_id || projectId,
            storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'seds-pakistan.appspot.com'
          });
          initMode = 'serviceAccount';
          return adminApp;
        }
      } catch (_e) {
        // fall through
      }
    }

    // Strategy 2: Use FIREBASE_CONFIG JSON when provided by Hosting SSR (Firebase Hosting)
    const cfg = process.env.FIREBASE_CONFIG;
    if (cfg) {
      try {
        const parsed = JSON.parse(cfg);
        // Ensure projectId is set in the config
        if (!parsed.projectId && projectId) {
          parsed.projectId = projectId;
        }
        adminApp = admin.initializeApp(parsed);
        initMode = 'firebaseConfig';
        return adminApp;
      } catch (_e) {
        // fall through
      }
    }

    // Strategy 3: Firebase Hosting environment (no credentials needed)
    // In Firebase Hosting, we can initialize without credentials when FIREBASE_CONFIG is present
    if (cfg) {
      try {
        adminApp = admin.initializeApp({
          projectId
        });
        initMode = 'firebaseHosting';
        return adminApp;
      } catch (_e) {
        // fall through
      }
    }

    // Strategy 3: Use Application Default Credentials (ADC) with explicit projectId
    // Only use ADC if we're NOT in Firebase Hosting environment (i.e., no FIREBASE_CONFIG)
    if (projectId && !cfg) {
      try {
        adminApp = admin.initializeApp({
          credential: admin.credential.applicationDefault(),
          projectId
        });
        initMode = 'adcWithProject';
        return adminApp;
      } catch (_e) {
        // fall through
      }
    }

    // Strategy 4: Default initialize (let Firebase SDK auto-discover)
    try {
      adminApp = admin.initializeApp();
      initMode = 'default';
      return adminApp;
    } catch (_e) {
      // fall through
    }

    // If all strategies fail, return null
    lastError = 'All initialization strategies failed';
    initMode = 'error';
    return null;
  } catch (e: any) {
    lastError = e?.message ?? String(e);
    initMode = 'error';
    return null;
  }
}

// Backward-compatible helpers used by existing routes
export function getDb(): FirebaseFirestore.Firestore | null {
  try {
    if (adminDb) return adminDb;
    const app = getOrInitAdminApp();
    if (!app) {
      console.error(`[firebase-admin] App initialization failed. InitMode: ${initMode}, Error: ${lastError}`);
      return null;
    }
    adminDb = getFirestore(app);
    
    // Connect to Firestore emulator in development
    if (process.env.NODE_ENV === 'development' && process.env.FIRESTORE_EMULATOR_HOST) {
      console.log('[admin:firestore] Connecting to Firestore emulator at', process.env.FIRESTORE_EMULATOR_HOST);
      // Note: connectFirestoreEmulator is for client SDK, not Admin SDK
      // For Admin SDK, we need to set the FIRESTORE_EMULATOR_HOST environment variable
    }
    
    return adminDb;
  } catch (e: any) {
    lastError = e?.message ?? String(e);
    return null;
  }
}

export function ensureAdminInitialized(): boolean {
  const app = getOrInitAdminApp();
  if (!app) return false;
  if (!adminDb) {
    try {
      adminDb = getFirestore(app);
    } catch (e: any) {
      lastError = e?.message ?? String(e);
      return false;
    }
  }
  return true;
}

export function getLastAdminError(): string | null {
  return lastError;
}

export function getAdminDiagnostics() {
  return {
    initialized: admin.apps.length > 0,
    appsCount: admin.apps.length,
    initMode,
    projectId:
      process.env.FIREBASE_PROJECT_ID ||
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      (admin.apps.length ? (admin.app().options.projectId as string | undefined) : 'seds-pakistan'),
    env: {
      FIREBASE_CONFIG: !!process.env.FIREBASE_CONFIG,
      GOOGLE_CLOUD_PROJECT: !!process.env.GOOGLE_CLOUD_PROJECT,
      GCLOUD_PROJECT: !!process.env.GCLOUD_PROJECT,
      GOOGLE_APPLICATION_CREDENTIALS: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
      NODE_ENV: process.env.NODE_ENV,
    },
    lastError,
  };
}

export function getAdminStorage() {
  const app = getOrInitAdminApp();
  if (!app) return null;
  try {
    return admin.storage(app);
  } catch (e) {
    return null;
  }
}

export { admin, adminDb };
