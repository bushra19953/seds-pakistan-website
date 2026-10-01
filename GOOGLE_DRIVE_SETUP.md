# Google Drive Resume Upload Setup Guide

## 🚀 **Easy Setup (5 minutes)**

This guide will help you set up Google Drive integration for resume uploads using the **Google Picker API** - the easiest method that works with Firebase free tier.

### ✅ **What You Get**
- Users can select PDFs directly from their Google Drive
- No server-side code required
- Works with Firebase free plan (Spark)
- Files stay in user's Google Drive (no storage costs for you)
- PDF preview still works

---

## 📋 **Setup Steps**

### 1. **Enable Google Picker API**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable **Google Picker API**: `APIs & Services > Library > Search "Google Picker API" > Enable`

### 2. **Create API Key**
1. Go to `APIs & Services > Credentials`
2. Click **"Create Credentials" > "API Key"**
3. **Restrict the key** (important for security):
   - Application restrictions: `HTTP referrers`
   - Add your domain: `yourdomain.com/*` and `localhost:3000/*`
4. Copy the API key

### 3. **Add API Key to Your App**
Create a new file `src/config/google-drive.ts`:

```typescript
export const GOOGLE_DRIVE_CONFIG = {
  API_KEY: 'YOUR_API_KEY_HERE',
  CLIENT_ID: 'YOUR_CLIENT_ID_HERE', // Optional for now
  APP_ID: 'YOUR_PROJECT_ID_HERE' // From Google Cloud Console
};
```

### 4. **Update the Google Drive Component**
Replace the placeholder in `GoogleDriveUpload.tsx`:

```typescript
// Add this import
import { GOOGLE_DRIVE_CONFIG } from '@/config/google-drive';

// Update the picker creation
const picker = new window.google.picker.PickerBuilder()
  .setOAuthToken('') // Leave empty for now
  .setDeveloperKey(GOOGLE_DRIVE_CONFIG.API_KEY)
  .addView(window.google.picker.ViewId.DOCS)
  .setMimeTypes('application/pdf')
  .setCallback(pickerCallback)
  .setTitle('Select your resume (PDF)')
  .build();
```

---

## 🔒 **Security Notes**

### ✅ **Safe for Free Plan**
- Uses client-side only (no Cloud Functions needed)
- Files stay in user's Google Drive
- No storage costs for you
- API key is restricted to your domain

### ⚠️ **Important**
- Always restrict your API key to your domain
- Don't expose sensitive data in client-side code
- The API key only allows file selection, not file access

---

## 🧪 **Testing**

1. **Local testing**: Use `localhost:3000` in API key restrictions
2. **Deploy**: Add your production domain to restrictions
3. **Test both methods**: Firebase upload AND Google Drive selection

---

## 📁 **How It Works**

```
User selects "Google Drive" → Google Picker opens → User selects PDF → 
URL is saved to form → PDF preview works → URL is submitted with application
```

**The resume stays in the user's Google Drive** - you're just storing the link!

---

## 🆘 **Troubleshooting**

### **Picker doesn't open**
- Check API key is correct
- Ensure Google Picker API is enabled
- Check browser console for errors

### **PDF preview fails**
- Google Drive files need conversion to direct download URL
- The component handles this automatically
- Check CORS errors in console

### **"API key invalid"**
- Verify API key restrictions
- Ensure your domain is added
- Check if key is enabled

---

## 🎯 **Next Steps**

1. **Follow the setup steps above**
2. **Test locally** with `npm run dev`
3. **Deploy** to your domain
4. **Add your domain** to API key restrictions

**That's it!** 🎉 Your users can now select resumes directly from Google Drive without any server costs or Firebase plan upgrades.