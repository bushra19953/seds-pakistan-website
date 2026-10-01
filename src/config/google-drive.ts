// Google Drive API Configuration
// Copy this file and rename to google-drive.ts
// Add your actual API key from Google Cloud Console

export const GOOGLE_DRIVE_CONFIG = {
  // Get this from Google Cloud Console: APIs & Services > Credentials > Create API Key
  API_KEY: 'AIzaSyC9PCSC4SDKOqm36U7rl_gNI2ybYuB6rTc',
  
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