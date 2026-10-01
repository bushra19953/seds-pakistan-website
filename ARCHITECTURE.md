# SEDS Pakistan Website - Architecture Documentation

## Project Structure Overview

The SEDS Pakistan website is built using Next.js 15 with App Router, Firebase backend services, and TypeScript. The application follows a modular architecture with clear separation of concerns.

### Core Directories

- **`/src/app`** - Next.js App Router pages and API routes
- **`/src/components`** - React components organized by feature and type
- **`/src/hooks`** - Custom React hooks for state management and data fetching
- **`/src/lib`** - Utility functions, types, and business logic
- **`/src/firebase`** - Firebase configuration, providers, and authentication
- **`/src/types`** - TypeScript type definitions
- **`/src/ai`** - AI/ML integration using Google Genkit
- **`/public/assets`** - Static assets (images, icons, logos)

## Complete Page & Routing List

### Public Pages
- **`/`** - Homepage with hero section, news, projects, and workshops
- **`/about`** - About page with mission and team information
- **`/blog`** - Blog listing page
- **`/blog/[id]`** - Individual blog post pages
- **`/blog/post/[id]`** - Alternative blog post route
- **`/events`** - Events listing page
- **`/events/[id]`** - Individual event pages
- **`/events/detail/[id]`** - Event detail pages
- **`/gallery`** - Image gallery page
- **`/podcast`** - Podcast page
- **`/projects`** - Projects listing page
- **`/projects/[slug]`** - Individual project pages
- **`/projects/detail/[id]`** - Project detail pages
- **`/resources`** - Resources page
- **`/workshops`** - Workshops listing page
- **`/workshops/[slug]`** - Individual workshop pages
- **`/workshops/detail/[slug]`** - Workshop detail pages

### Authentication Pages
- **`/auth/login`** - Login page with enhanced authentication form
- **`/login`** - Alternative login route
- **`/auth/signup`** - Signup page
- **`/signup`** - Alternative signup route
- **`/auth/reset-password`** - Password reset page

### User Dashboard Pages
- **`/profile`** - User profile management
- **`/profile/[uid]`** - View other user profiles
- **`/profile/view`** - Profile view page
- **`/profile/unified`** - Unified profile page
- **`/user/profile`** - Alternative user profile route

### Application Pages
- **`/induction`** - Member induction application form
- **`/invite`** - Invite acceptance page

### Admin Pages (Protected)
- **`/admin`** - Main admin dashboard
- **`/admin/analytics`** - Analytics dashboard
- **`/admin/announcements`** - Announcements management
- **`/admin/applications`** - Applications management
- **`/admin/audit`** - Audit logs
- **`/admin/audit-logs`** - Detailed audit logs
- **`/admin/backup-restore`** - Backup and restore functionality
- **`/admin/blog`** - Blog management
- **`/admin/blogs`** - Alternative blog management
- **`/admin/events`** - Event management
- **`/admin/forms`** - Form management
- **`/admin/gallery`** - Gallery management
- **`/admin/importer`** - Data import tools
- **`/admin/pages`** - Page management
- **`/admin/projects`** - Project management
- **`/admin/resources`** - Resource management
- **`/admin/roles`** - Role management
- **`/admin/skills`** - Skills management
- **`/admin/superadmin`** - Super admin controls
- **`/admin/timeline`** - Timeline management
- **`/admin/users`** - User management
- **`/admin/versioning`** - Content versioning
- **`/admin/workshops`** - Workshop management

### API Routes
- **`/api/upload-resume`** - Resume upload endpoint

### Test/Demo Pages (To be removed)
- **`/demo`** - UX enhancement demo page
- **`/test-rbac`** - RBAC testing page
- **`/test-student`** - Student testing page

### AI Features
- **`/copilot`** - AI research copilot interface

## State Management Strategy

### Global State Management
The application uses a hybrid approach combining Firebase real-time data with React Context for specific use cases:

#### Firebase-based State
- **User Authentication**: Managed through Firebase Auth with real-time listeners
- **User Roles**: Real-time role management using Firestore listeners
- **Application Data**: Projects, blogs, events, workshops fetched on-demand

#### React Context Providers
- **`FirebaseProvider`**: Provides Firebase services (auth, firestore, storage) to the component tree
- **`ThemeProvider`**: Manages light/dark theme switching
- **`ToastProvider`**: Global toast notification system

#### Custom Hooks for State Management
- **`useUser`**: Combines authentication state with user role information
- **`useRole`**: Fetches and manages user roles with caching
- **`useProjects`**, **`useBlogs`**, **`useWorkshops`**: Data fetching hooks with loading states

### Local Component State
Components manage their own state using:
- `useState` for component-specific data
- `useEffect` for side effects and data fetching
- `useReducer` for complex state logic (where applicable)

## Data Fetching & Backend Interaction

### Firebase Integration
The application uses Firebase as the primary backend service:

#### Authentication
- **Service**: Firebase Authentication
- **Provider**: Email/password, Google OAuth
- **Hooks**: `useUser`, `useRole` for authentication state

#### Database
- **Service**: Cloud Firestore
- **Pattern**: Real-time listeners with on-demand fetching
- **Caching**: Role-based caching in `useRole` hook

#### File Storage
- **Service**: Firebase Storage
- **Use Cases**: Resume uploads, image galleries, document storage

### Data Fetching Patterns

#### Real-time Data (Firestore Listeners)
```typescript
// Role management uses real-time listeners
const unsubscribe = onSnapshot(docRef, (doc) => {
  // Update state when data changes
});
```

#### On-demand Fetching
```typescript
// Projects, blogs, events use on-demand fetching
const fetchProjects = async () => {
  const q = query(collection, orderBy('created_at', 'desc'), limit(num));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
};
```

#### Error Handling
- Firebase errors are caught and logged
- User-friendly error messages via toast notifications
- Graceful degradation when services are unavailable

## Component Architecture

### Component Organization Philosophy

#### UI Components (`/src/components/ui`)
- **Purpose**: Reusable, atomic UI elements
- **Examples**: Button, Card, Dialog, Form elements
- **Styling**: Tailwind CSS with class-variance-authority for variants
- **Library**: Built on Radix UI primitives for accessibility

#### Feature Components (`/src/components`)
- **Purpose**: Business logic and feature-specific components
- **Examples**: `enhanced-auth-form.tsx`, `induction-stepper`, `layout`
- **Responsibility**: Handle user interactions, data fetching, state management

#### Layout Components (`/src/components/layout`)
- **Purpose**: Page structure and navigation
- **Examples**: `header.tsx`, `footer.tsx`, `admin-layout.tsx`
- **Function**: Provide consistent page layouts and navigation

#### Section Components (`/src/components/sections`)
- **Purpose**: Page-specific content sections
- **Examples**: `hero-section.tsx`, `projects-section.tsx`, `news-section.tsx`
- **Usage**: Composable building blocks for page content

### Component Design Principles
1. **Separation of Concerns**: UI logic separated from business logic
2. **Reusability**: UI components are highly reusable across the application
3. **Composition**: Complex components built by composing simpler ones
4. **Type Safety**: Full TypeScript coverage with proper prop typing
5. **Accessibility**: Built on accessible primitives (Radix UI)

## Authentication & Authorization (RBAC)

### Role-Based Access Control System

#### Role Hierarchy
```typescript
type UserRole = 'superadmin' | 'admin' | 'founder' | 'team_leader' | 'blog_writer' | 'member' | 'guest';

const ROLE_HIERARCHY = {
  superadmin: 7,
  founder: 6,
  admin: 5,
  team_leader: 4,
  blog_writer: 3,
  member: 2,
  guest: 1,
};
```

#### Authentication Flow
1. **Login**: Users authenticate via Firebase Auth (email/password or Google)
2. **User Document**: Automatic creation of user document in Firestore
3. **Role Assignment**: Default role of 'member' assigned to new users
4. **Role Fetching**: Real-time role listener updates user permissions

#### Authorization Implementation

##### Route Protection
```typescript
// Higher-order component for admin protection
export function withAdminProtection(Component: React.ComponentType) {
  return function ProtectedComponent(props: any) {
    const { user, role, isLoading } = useUser();
    
    if (isLoading) return <LoadingSpinner />;
    if (!user || !hasSufficientRole(role, 'admin')) {
      return <AccessDenied />;
    }
    
    return <Component {...props} />;
  };
}
```

##### Role Checking
```typescript
// Hook-based role checking
const { role, hasRole } = useRole(userId);
const canEdit = hasRole(['admin', 'blog_writer']);
```

##### Page-level Protection
- Admin pages check role before rendering
- Redirect to login for unauthenticated users
- Show access denied for insufficient permissions

#### Security Features
- **CSRF Protection**: Implemented for sensitive operations
- **Input Validation**: Zod schemas for form validation
- **Rate Limiting**: Applied to authentication endpoints
- **Audit Logging**: All admin actions are logged
- **Error Handling**: Secure error messages that don't expose system details

### Data Security
- **Firestore Rules**: Database-level security rules
- **Role-based Queries**: Frontend queries respect user permissions
- **File Upload Security**: Validation for uploaded files
- **Environment Variables**: Sensitive configuration in environment variables

## Technology Stack

### Frontend
- **Framework**: Next.js 15 with App Router
- **Language**: TypeScript
- **Styling**: Tailwind CSS with custom components
- **UI Library**: Radix UI primitives
- **State Management**: React hooks with Firebase real-time data
- **Forms**: React Hook Form with Zod validation

### Backend & Services
- **Authentication**: Firebase Authentication
- **Database**: Cloud Firestore
- **Storage**: Firebase Storage
- **AI/ML**: Google Genkit for AI features
- **Hosting**: Firebase Hosting

### Development Tools
- **Build Tool**: Next.js with Turbopack
- **Linting**: ESLint with Next.js config
- **Formatting**: Prettier
- **Testing**: Jest with React Testing Library
- **Type Checking**: TypeScript

## Performance Considerations

### Optimization Strategies
1. **Code Splitting**: Automatic with Next.js App Router
2. **Image Optimization**: Next.js Image component with Sharp
3. **Bundle Analysis**: Available via `npm run build:analyze`
4. **Lazy Loading**: Dynamic imports for heavy components
5. **Caching**: Role caching and Firestore query optimization

### Monitoring
- **Page Visit Tracking**: Anonymous analytics
- **Error Tracking**: Firebase error logging
- **Performance**: Built-in Next.js performance monitoring

## Future Enhancements

### Identified Opportunities
1. **Component Consolidation**: Merge similar components
2. **Hook Optimization**: Centralize similar data fetching logic
3. **Type Safety**: Enhance TypeScript coverage
4. **Performance**: Implement advanced caching strategies
5. **Testing**: Expand test coverage for critical features

This architecture provides a solid foundation for the SEDS Pakistan website while maintaining flexibility for future enhancements and scalability.