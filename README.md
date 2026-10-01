# 🚀 SEDS Pakistan Website

Official website of the Society of Engineering and Design Students (SEDS) Pakistan.  
Built with **Next.js 15**, **Firebase**, and **Tailwind CSS**.

🌐 **Live site**: https://v0-seds-pakistan.vercel.app

---

## ⚙️ Local Setup (for developers)

### 1. Prerequisites
- [Node.js](https://nodejs.org/) v18 or higher
- [npm](https://www.npmjs.com/) (comes with Node)

### 2. Clone the repo
```bash
git clone https://github.com/bushra19953/seds-pakistan-website.git
cd seds-pakistan-website
```

### 3. Install dependencies
```bash
npm install
```

### 4. Set up environment variables
```bash
# Copy the example file
cp .env.example .env.local

# Then open .env.local and fill in your Firebase credentials
# (Get them from Firebase Console → Project Settings → Your Apps)
```

> ⚠️ **You MUST set up Firebase credentials** — the app cannot run without them.  
> Contact the project maintainer to get the required values.

### 5. Run the development server
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🔑 Required Environment Variables

See [`.env.example`](.env.example) for the full list. The key ones are:

| Variable | Where to get it |
|---|---|
| `NEXT_PUBLIC_FIREBASE_*` | Firebase Console → Project Settings → Your App |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Console → Project Settings → Service Accounts |
| `NEXT_PUBLIC_FIREBASE_VAPID_KEY` | Firebase Console → Cloud Messaging → Web Push Certificates |

---

## 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router, SSR) |
| Auth | Firebase Authentication |
| Database | Firestore |
| Storage | Firebase Storage |
| Styling | Tailwind CSS + shadcn/ui |
| Email | Gmail SMTP via Nodemailer |
| Deployment | Vercel |

---

## 📁 Project Structure

```
src/
├── app/          # Next.js App Router pages & API routes
├── components/   # Reusable React components
├── firebase/     # Firebase client & hooks
├── lib/          # Utilities, mailer, server helpers
├── hooks/        # Custom React hooks
└── types/        # TypeScript type definitions
```

---

## 🚢 Deployment

The project auto-deploys to Vercel on every push to `main`.

To deploy manually:
```bash
npm run build   # Build production bundle
```

---

## 📬 Contact

For access to Firebase credentials or environment variables, contact the SEDS Pakistan tech team.
