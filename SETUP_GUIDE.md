# SEDS Pakistan Website - Setup Guide

## Prerequisites

- Node.js version 18.0.0 - 22.x (check with `node --version`)
- npm (comes with Node.js)
- Git

## Step 1: Clone Repository

```bash
git clone <repository-url>
cd seds-pakistan-website
```

## Step 2: Install Dependencies

```bash
npm install
```

**Note**: If you encounter permission issues, try:
```bash
npm install --legacy-peer-deps
```

## Step 3: Environment Configuration

Create a `.env.local` file in the project root:

```bash
copy .env.example .env.local
```

If `.env.example` doesn't exist, create `.env.local` with these required variables:

```env
# Firebase Configuration
NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
NEXT_PUBLIC_FIREBASE_FOUNDER_UID=your_founder_uid

# Google Services
GOOGLE_GENAI_API_KEY=your_google_ai_key
API_KEY=your_google_drive_api_key

# Security
CSRF_SECRET=your_csrf_secret_key
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=your_encryption_key

# Development
NODE_ENV=development
```

## Step 4: Fix Known Issues (Critical)

Before running the development server, you MUST fix these TypeScript errors:

### Fix 1: Role Hierarchy Error
Edit `src/hooks/use-contextual-redirect.tsx` line 293:
```typescript
const roleHierarchy: Record<UserRole, number> = {
  guest: 0,
  member: 1,
  blog_writer: 2,
  curator: 3,
  team_leader: 4,
  admin: 5,
  superadmin: 6,
  founder: 7,  // Add this line
};
```

### Fix 2: Toast Component Errors
Edit `src/hooks/use-enhanced-toast.tsx`:
- Change `description?: string;` to `description?: React.ReactNode;` (line 13)
- Fix toast function calls to use correct signature

### Fix 3: WebGL Component Safety
The Satellite3D component has WebGL issues. We'll provide a safe version in the next update.

## Step 5: Run Development Server

```bash
npm run dev
```

The server will start on **http://localhost:9004**

**Expected Output**:
```
> seds-pakistan-website@1.0.0 dev
> next dev --turbopack -p 9004

  ▲ Next.js 15.5.4 (Turbopack)
  - Local:        http://localhost:9004
  - Network:      http://192.168.x.x:9004

 ✓ Starting...
 ✓ Ready in 2.5s
```

## Step 6: Verify Installation

1. Open **http://localhost:9004** in your browser
2. You should see the SEDS Pakistan homepage
3. Check browser console for any errors
4. Test navigation to ensure all pages load

## Troubleshooting

### Port Already in Use
If port 9004 is occupied:
```bash
# Kill process using port 9004 (Windows)
netstat -ano | findstr :9004
taskkill /PID <PID> /F

# Or use different port
npm run dev -- -p 3000
```

### Build Errors
```bash
# Clean build cache
npm run clean
npm install

# Check TypeScript errors
npm run typecheck
```

### Firebase Errors
Ensure all Firebase environment variables are correctly set in `.env.local`.

#### Production (Firebase Hosting + Frameworks SSR)

- Client SDK must point to the production project (`src/firebase/config.ts`).
- Server (Admin SDK) uses `FIREBASE_PROJECT_ID` or `NEXT_PUBLIC_FIREBASE_PROJECT_ID` and can initialize via service account or Application Default Credentials (ADC).
- Deploy with `npm run build` and `npx firebase deploy --only hosting`.
- Validate after deploy using the health endpoint:
  - `GET /api/health/firebase?code=<CERT_CODE>` returns initialization status, projectId, and whether the certificate exists.

#### Firestore Rules

- Server API routes use Admin SDK and are not restricted by rules.
- For client-side writes (e.g., page visit tracking), confirm authentication and rules permit the operation on production.

#### Troubleshooting Checklist

- Confirm `Cloud Firestore API` is enabled in GCP for the production project.
- Check Hosting logs for Admin initialization and route success messages.
- If production returns “Certificate Invalid” for codes that work locally, ensure those documents exist in the production Firestore `certificates` collection (data mismatch is common).

### WebGL Component Crashes
If you see WebGL errors, the 3D components will be disabled automatically in the next update.

## Development Commands

```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run start        # Start production server
npm run lint         # Run ESLint
npm run lint:fix       # Fix ESLint errors
npm run typecheck    # Check TypeScript errors
npm test             # Run tests
```

## Next Steps

After successful setup:
1. Fix the TypeScript errors as described above
2. Configure your Firebase project
3. Set up Google Drive API if needed
4. Review the technical specification document

**Important**: Do not proceed to production deployment until all TypeScript errors are resolved and the application runs without console errors.
