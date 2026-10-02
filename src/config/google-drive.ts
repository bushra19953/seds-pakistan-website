// Google Drive API Configuration
// The API key is loaded from the NEXT_PUBLIC_GOOGLE_DRIVE_API_KEY
// environment variable (see .env.example). Never hardcode it here.
// Get a key from Google Cloud Console: APIs & Services > Credentials > Create API Key

export const GOOGLE_DRIVE_CONFIG = {
  // Inlined at build time from the environment; restrict via HTTP referrers in GCP console
  API_KEY: process.env.NEXT_PUBLIC_GOOGLE_DRIVE_API_KEY || '',
  
  // Optional: For OAuth (if needed later)
  CLIENT_ID: 'YOUR_OAUTH_CLIENT_ID_HERE',
  
  // Your Google Cloud Project ID (found in Firebase config: projectId)
  APP_ID: 'seds-pakistan'
};

// Instructions:
// 1. Go to https://console.cloud.google.com/
// 2. Create a new project or select existing
// 3. Enable Google Picker API
// 4. Create an API key with HTTP referrer restrictions
// 5. Add your domains: yourdomain.com/* and localhost:3000/*
// 6. Replace the placeholder values above