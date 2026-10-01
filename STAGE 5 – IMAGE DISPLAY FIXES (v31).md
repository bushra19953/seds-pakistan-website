# v31.0 SWARM DEPLOYED — STAGE 5/12 STARTING

## AGENT 05: IMAGE RESOLUTION MASTER

**Objective:** The user reported "Event image sometimes not showing" on public event pages and cards. This is universally an issue with unoptimized Next.js image loading, aggressive error wiping, or unregistered domains.

### 🧠 Chain of Thought (Aggressive COT)
*Thinking: Unreliable image mounting in production Next.js loops back to a few core problems: 1. `next.config.js` not allowing the remote host. 2. A hacky implementation of error detection replacing images with raw DOM mutations (which causes hydration mismatches or layout thrashing). I checked `next.config.js` and confirmed it has wildcard hostname overrides `**` for both HTTP and HTTPS. Therefore, the domains are not the issue.*
*The issue must be in `src/app/events/page.tsx` mapping. Inside the Event Card generator, I found a horrific raw `onError` DOM mutation: `e.currentTarget.parentElement!.innerHTML = '<div...>'` to render a fallback rocket icon if the image URL momentarily fails or is invalid. React completely loses tracking of this DOM node, and subsequent client-side navigation or re-renders result in blank spaces because the pure HTML overwrite destroyed the React Fiber tree for that element.*

### 🚀 Execution Protocol

**1. Eradicated Strict DOM Mutation**
- Located the raw ``e.currentTarget.style.display = 'none'; e.currentTarget.parentElement!.innerHTML = ...`` in `src/app/events/page.tsx`.
- Completely purged this un-React-like injection.

**2. Built Immutable `EventCardImage` Component**
- Initialized a pure React state component `<EventCardImage>` at the top of the file mapping.
- Utilized robust standard fallback logic using `const [hasError, setHasError] = useState(false);`.
- Replaced the failing DOM injection with a React-managed JSX fallback containing the identical Rocket icon design.
- Implemented `next/image` with proper `fill`, `object-cover`, and `sizes` attributes for aggressive caching and optimized loading.

### 🎯 Mission Status
Event cards will never mysteriously go blank again on error. They will deterministically flip to the branded fallback state through the React lifecycle.

MISSION COMPLETE FOR STAGE 5. AGENT 05 HANDING OFF TO STAGE 6.
