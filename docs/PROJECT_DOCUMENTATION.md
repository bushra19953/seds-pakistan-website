# Project Documentation

## Overview
This document serves as the central hub for all project documentation, converted from the JSON technical specification to maintainable Markdown format. All documentation should be kept up-to-date with code changes.

## Architecture Documentation

### System Architecture
- **Framework**: Next.js 14.2.5 with App Router
- **Language**: TypeScript 5.5.4
- **Styling**: Tailwind CSS 3.4.35
- **UI Components**: Radix UI + Custom Design System
- **Database**: Firebase Firestore
- **Authentication**: Firebase Authentication
- **File Storage**: Firebase Storage + Google Drive Integration

### Key Architectural Decisions

#### 1. Component Architecture
```
Components follow a hierarchical structure:
- atoms/ (basic UI elements)
- molecules/ (compound components)
- organisms/ (complex components)
- templates/ (page layouts)
- pages/ (Next.js pages)
```

#### 2. State Management
```
State is managed through:
- React Context (authentication, global state)
- React Query (server state)
- Local component state (form inputs, UI state)
- Firebase real-time updates
```

#### 3. Data Flow
```
Client → Firebase Auth → Context Provider → Components
                ↓
            Firestore → Real-time Updates → UI Updates
```

## Component Documentation

### Core Components

#### Authentication Components
- **AuthForm**: Handles user login/registration with email and social providers
- **EnhancedAuthForm**: Extended version with additional validation and features
- **UseUser Hook**: Manages authentication state and user profile data

#### UI Components
- **Button**: Primary interactive element with variants (primary, secondary, destructive)
- **Input**: Form input with validation and error handling
- **Toast**: Notification system for user feedback
- **Card**: Content container with consistent styling

#### 3D Components
- **Satellite3D**: Interactive 3D satellite model using Three.js
- **Rover3D**: Interactive 3D rover model
- **StarryBackground**: Animated starfield background

### Component Patterns

#### 1. Compound Components
```tsx
// Example: Card component pattern
<Card>
  <CardHeader>
    <CardTitle>Title</CardTitle>
    <CardDescription>Description</CardDescription>
  </CardHeader>
  <CardContent>
    {/* Content */}
  </CardContent>
</Card>
```

#### 2. Render Props
```tsx
// Example: Authentication-required component
<RequireAuth>
  {(user) => <Dashboard user={user} />}
</RequireAuth>
```

#### 3. Custom Hooks
```tsx
// Example: Data fetching hook
const { data, loading, error } = useFirestoreDocument('users', userId);
```

## API Documentation

### Firebase Integration

#### Authentication
```typescript
// Sign up with email/password
const userCredential = await createUserWithEmailAndPassword(auth, email, password);

// Sign in with social provider
const provider = new GoogleAuthProvider();
const result = await signInWithPopup(auth, provider);

// Get current user
const user = auth.currentUser;
```

#### Firestore Operations
```typescript
// Read document
const docRef = doc(db, 'collection', 'documentId');
const docSnap = await getDoc(docRef);

// Write document
await setDoc(docRef, { field: 'value' }, { merge: true });

// Real-time listener
const unsubscribe = onSnapshot(docRef, (doc) => {
  // Handle update
});
```

#### File Storage
```typescript
// Upload file
const storageRef = ref(storage, 'path/to/file.jpg');
const snapshot = await uploadBytes(storageRef, file);
const downloadURL = await getDownloadURL(snapshot.ref);
```

### External APIs

#### Google Drive Integration
```typescript
// Initialize Google Drive API
const gapi = await loadGapiClient();
await gapi.client.drive.files.list({
  q: "mimeType='image/jpeg'",
  fields: 'files(id, name, webViewLink)'
});
```

## Configuration Documentation

### Environment Variables

#### Required Variables
```bash
# Firebase Configuration
NEXT_PUBLIC_FIREBASE_API_KEY=your_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_bucket.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id

# Google OAuth
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret

# GitHub OAuth
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret

# Google Drive API
GOOGLE_DRIVE_API_KEY=your_drive_api_key
```

#### Optional Variables
```bash
# Application Settings
NEXT_PUBLIC_APP_URL=https://your-domain.com
NEXT_PUBLIC_ENABLE_ANALYTICS=true

# Security
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_WINDOW_MS=900000

# Performance
NEXT_PUBLIC_IMAGE_OPTIMIZATION=true
```

### Build Configuration

#### Next.js Configuration
```typescript
// next.config.ts
const nextConfig = {
  images: {
    domains: ['firebasestorage.googleapis.com'],
    unoptimized: false, // Enable image optimization
  },
  experimental: {
    optimizePackageImports: ['@radix-ui/react-icons'],
  },
};
```

## Deployment Documentation

### Build Process
```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

### Firebase Hosting Configuration
```json
// firebase.json
{
  "hosting": {
    "public": "out",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      {
        "source": "**",
        "destination": "/index.html"
      }
    ]
  }
}
```

## Security Documentation

### Authentication Security
- **Firebase Security Rules**: Implemented in `firestore.rules`
- **Rate Limiting**: Applied to authentication endpoints
- **Input Validation**: Client and server-side validation
- **Session Management**: Firebase handles session security

### Data Protection
- **Encryption**: Data encrypted in transit and at rest
- **Access Control**: Role-based access control (RBAC)
- **Audit Logging**: User actions logged for security monitoring
- **GDPR Compliance**: User data deletion capabilities

## Performance Documentation

### Optimization Strategies

#### 1. Code Splitting
```typescript
// Dynamic imports for heavy components
const Satellite3D = dynamic(() => import('@/components/satellite-3d'), {
  loading: () => <LoadingSpinner />,
  ssr: false
});
```

#### 2. Image Optimization
```typescript
// Use Next.js Image component
import Image from 'next/image';

<Image
  src="/hero-image.jpg"
  alt="Hero"
  width={1920}
  height={1080}
  priority
  placeholder="blur"
/>;
```

#### 3. Caching Strategy
```typescript
// Static page caching
export const revalidate = 3600; // Revalidate every hour

// Dynamic data caching
const { data } = await fetch('/api/data', {
  next: { revalidate: 60 }
});
```

### Performance Monitoring
- **Lighthouse CI**: Automated performance testing
- **Web Vitals**: Core Web Vitals monitoring
- **Error Tracking**: Sentry integration for error monitoring
- **Analytics**: Google Analytics for user behavior tracking

## Troubleshooting Guide

### Common Issues

#### 1. Firebase Authentication Errors
```
Error: auth/invalid-api-key
Solution: Check NEXT_PUBLIC_FIREBASE_API_KEY in environment variables
```

#### 2. Firestore Permission Errors
```
Error: Missing or insufficient permissions
Solution: Update Firestore security rules
```

#### 3. Build Errors
```
Error: Module not found
Solution: Check import paths and TypeScript configuration
```

#### 4. Performance Issues
```
Problem: Slow page loads
Solution: Enable image optimization, implement code splitting
```

### Debug Mode
```typescript
// Enable debug logging
localStorage.setItem('debug', 'app:*');

// Disable debug logging
localStorage.removeItem('debug');
```

## Maintenance Guidelines

### Code Quality
- **ESLint**: Enforce code style and best practices
- **Prettier**: Consistent code formatting
- **TypeScript**: Type safety and better IDE support
- **Husky**: Pre-commit hooks for quality checks

### Dependency Management
- **Regular Updates**: Monthly dependency updates
- **Security Audits**: Weekly security vulnerability scans
- **Breaking Changes**: Test thoroughly before major updates
- **Lock Files**: Commit package-lock.json for reproducible builds

### Documentation Updates
- **Code Changes**: Update documentation with code changes
- **API Updates**: Keep API documentation current
- **Configuration Changes**: Document configuration updates
- **New Features**: Add documentation for new features

## Support and Resources

### Internal Resources
- **Technical Specification**: `docs/TECHNICAL_SPECIFICATION.md`
- **Setup Guide**: `SETUP_GUIDE.md`
- **Testing Strategy**: `docs/TESTING_STRATEGY.md`
- **Technical Debt Plan**: `docs/TECHNICAL_DEBT_REDUCTION_PLAN.md`

### External Resources
- **Next.js Documentation**: https://nextjs.org/docs
- **Firebase Documentation**: https://firebase.google.com/docs
- **Tailwind CSS Documentation**: https://tailwindcss.com/docs
- **Radix UI Documentation**: https://radix-ui.com/docs

### Development Team
- **Lead Developer**: [Contact Information]
- **DevOps Engineer**: [Contact Information]
- **QA Engineer**: [Contact Information]
- **Product Owner**: [Contact Information]

---

**Document Version**: 1.0.0  
**Last Updated**: [Current Date]  
**Next Review**: [30 days from current date]