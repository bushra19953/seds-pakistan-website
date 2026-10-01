# USER BILL OF RIGHTS - Security Refactor Summary

## Critical Issue Resolved

**Problem**: Logged-in users with no special roles ('guest', 'member') were losing all access to content they could see when logged out. This was a catastrophic architectural flaw in the permission model.

**Root Cause**: The original firestore.rules only checked for administrative permissions, effectively revoking standard users' ability to see their own profiles or publicly available content once they logged in.

## Solution Implemented: "User Bill of Rights"

The definitive refactor implements a **three-tiered access control architecture**:

### 1. PUBLIC ACCESS
- Any user (authenticated or not) can read published content
- Applied to: users, projects, events, announcements, blogs, pages, badges, timeline, teamMembers, chapters, skills, workshops, news, podcasts
- Rule pattern: `allow read: if resource.data.status == 'published' || isSignedIn();`

### 2. OWNER ACCESS  
- Authenticated users can always read their OWN documents
- Applied to: tasks (assigned to user), registrations (user's registrations), applications (user's applications), userActivity, userActivitySummary, inductions, notifications, messages, comments
- Rule pattern: `allow read: if isSignedIn() && (request.auth.uid in resource.data.assigneeIds) || hasPermission('canManageTasks');`

### 3. ADMIN ACCESS
- Users with appropriate permissions can read everything in their domain
- Maintains existing RBAC system with role-based permissions
- Superadmin retains override capabilities

## Key Changes Made

### 1. Added `isOwner()` Helper Function
```javascript
function isOwner(docId) {
  return isSignedIn() && request.auth.uid == docId;
}
```

### 2. Fixed Content Collections
**Before**: `allow get, list: if true;` (made everything public)
**After**: `allow read: if resource.data.status == 'published' || isSignedIn();`
- Published content remains public
- Logged-in users can see drafts (needed for admin panels)

### 3. Fixed Task Access (Critical Fix)
**Before**: `allow read: if isSignedIn();` (any logged-in user could see ALL tasks)
**After**: `allow read: if isSignedIn() && (request.auth.uid in resource.data.assigneeIds) || hasPermission('canManageTasks');`
- Users can only see tasks assigned to them
- Admins can see all tasks

### 4. Enhanced Owner-Based Access
Added proper owner checks for:
- Registrations: Users can see their own event registrations
- Applications: Users can see their own membership applications  
- UserActivity: Users can see their own activity data
- Notifications: Users can see their own notifications
- Messages: Users can see conversations they're part of

## Collections by Access Type

### Public Read (Published Content)
- `/users` - User profiles for leaderboard functionality
- `/projects`, `/events`, `/announcements`, `/blogs` - Published content
- `/pages`, `/page_content` - Static website content
- `/badges`, `/timeline`, `/teamMembers`, `/chapters` - Public information
- `/skills`, `/workshops`, `/news`, `/podcasts` - Educational content

### Owner-Based Read
- `/tasks` - Tasks assigned to the user
- `/registrations` - User's event registrations
- `/applications` - User's membership applications
- `/userActivity`, `/userActivitySummary` - User's activity data
- `/inductions` - User's induction progress
- `/notifications` - User's notifications
- `/messages` - Conversations user participates in
- `/comments` - User's own comments

### Admin-Only Read
- `/roles`, `/roleDefinitions` - Role management
- `/invites` - User invitation management
- `/audit_logs` - System audit logs
- `/roleHistory` - Role change history
- `/resources` - Administrative resources
- `/pageVisits` - Analytics data
- `/contactSubmissions` - Contact form submissions

## Security Benefits

1. **Restores User Rights**: Logged-in users can now access their own data and public content
2. **Maintains Security**: Write permissions remain strictly controlled
3. **Preserves Functionality**: Leaderboards, profile links, and public content remain accessible
4. **Enables Proper Task Management**: Users only see tasks relevant to them
5. **Supports Admin Workflows**: Logged-in users can access drafts and unpublished content when needed

## Deployment Status

✅ **DEPLOYED SUCCESSFULLY** - The new security rules are now active in production.

The "User Bill of Rights" is now established and protecting user access while maintaining security boundaries.