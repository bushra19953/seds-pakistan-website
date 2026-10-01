# Firebase Studio

This is a NextJS starter in Firebase Studio.

To get started, take a look at src/app/page.tsx.

## Deployment (Firebase Hosting + Functions)

Root Cause

- Hosting served static files, but the app is SSR and doesn’t produce an `index.html`. Without SSR rewrites, Firebase Hosting fell back to its default “Page Not Found”.
- The first deploy failed due to a Windows file lock on `.next/trace` (EPERM). The dev server was holding `.next`, so the frameworks build couldn’t finish, leaving Hosting without SSR routing.

What Fixed It

- Stopped the dev server, cleared `.next`, enabled Firebase Web Frameworks, and deployed Hosting + Functions. This provisioned the Next.js SSR function and rewrites.
- Live site: https://seds-pakistan.web.app
- SSR function: https://ssrsedspakistan-gxlrukvoaa-uc.a.run.app

How to Avoid This

- When deploying this project, always deploy both hosting and functions (SSR):
  - `npx firebase deploy --only hosting,functions`
- Don’t run the dev server during deploy; it can lock `.next` on Windows.
- If you ever want pure static hosting, switch to `output: 'export'` in `next.config.ts` and set `"public": "out"` in `firebase.json` — otherwise Hosting expects SSR rewrites, not `index.html`.

Windows Tips

- Stop any running dev server before deploying.
- Clear the Next build cache if you encounter EPERM locks:
  - PowerShell: `Remove-Item .next -Recurse -Force`
  - CMD: `rmdir /s /q .next`
