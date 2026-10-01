import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { GOOGLE_DRIVE_CONFIG } from '@/config/google-drive';

// Google Picker API types
declare global {
  interface Window {
    google: any;
    gapi: any;
  }
}

interface GoogleDriveUploadProps {
  onFileSelect: (fileUrl: string, fileName: string) => void;
  disabled?: boolean;
}

export default function GoogleDriveUpload({ onFileSelect, disabled }: GoogleDriveUploadProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  // Load Google APIs
  const loadGoogleAPI = () => {
    return new Promise((resolve, reject) => {
      console.log('=== Checking Google API Status ===');
      console.log('window.gapi:', window.gapi);
      console.log('window.google:', window.google);
      
      if (window.gapi && window.google && window.google.picker) {
        console.log('Google APIs already loaded');
        resolve(true);
        return;
      }

      console.log('Loading Google API script...');
      const script = document.createElement('script');
      script.src = 'https://apis.google.com/js/api.js?onload=onGoogleApiLoad';
      
      // Create global callback
      (window as any).onGoogleApiLoad = () => {
        console.log('Google API script loaded via callback');
        if (window.gapi && window.gapi.load) {
          console.log('Loading client:picker modules...');
          window.gapi.load('client:picker', {
            callback: () => {
              console.log('client:picker modules loaded successfully');
              console.log('window.google after loading:', window.google);
              console.log('window.google.picker:', window.google?.picker);
              resolve(true);
            },
            onerror: (error: any) => {
              console.error('Failed to load client:picker modules:', error);
              reject(new Error('Failed to load Google Picker modules'));
            }
          });
        } else {
          console.error('gapi or gapi.load not available after script load');
          reject(new Error('Google API failed to load properly'));
        }
      };
      
      script.onerror = (error) => {
        console.error('Failed to load Google API script:', error);
        reject(new Error('Failed to load Google API script'));
      };
      
      document.head.appendChild(script);
    });
  };

  // Initialize Google Picker
  const showGooglePicker = async () => {
    try {
      setIsLoading(true);
      
      console.log('=== Starting Google Picker Initialization ===');
      console.log('Google Drive API Key:', GOOGLE_DRIVE_CONFIG.API_KEY);
      console.log('Google Drive APP_ID:', GOOGLE_DRIVE_CONFIG.APP_ID);
      
      // Check if API key is configured
      if (!GOOGLE_DRIVE_CONFIG.API_KEY || GOOGLE_DRIVE_CONFIG.API_KEY === 'YOUR_GOOGLE_API_KEY_HERE') {
        toast({
          variant: 'destructive',
          title: 'Google Drive Not Configured',
          description: 'Please set up your Google Drive API key. Check the setup guide in GOOGLE_DRIVE_SETUP.md',
        });
        return;
      }
      
      // Add timeout for API loading
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Google API loading timeout')), 10000)
      );
      
      console.log('Loading Google API...');
      await Promise.race([loadGoogleAPI(), timeoutPromise]);
      console.log('Google API loaded successfully');
      
      // Additional check for Google Picker availability
      console.log('Checking Google Picker availability:');
      console.log('window.google:', window.google);
      console.log('window.google.picker:', window.google?.picker);
      console.log('window.google.picker.PickerBuilder:', window.google?.picker?.PickerBuilder);
      
      if (!window.google || !window.google.picker || !window.google.picker.PickerBuilder) {
        throw new Error('Google Picker API not available - missing picker components');
      }
      
      // Create picker
      console.log('Creating picker with config:', {
        appId: GOOGLE_DRIVE_CONFIG.APP_ID,
        apiKey: GOOGLE_DRIVE_CONFIG.API_KEY,
        hasGoogleObject: !!window.google,
        hasPicker: !!window.google?.picker,
        hasPickerBuilder: !!window.google?.picker?.PickerBuilder
      });
      
      const picker = new window.google.picker.PickerBuilder()
        .setAppId(GOOGLE_DRIVE_CONFIG.APP_ID)
        .setDeveloperKey(GOOGLE_DRIVE_CONFIG.API_KEY)
        .addView(window.google.picker.ViewId.DOCS)
        .setMimeTypes('application/pdf')
        .setCallback(pickerCallback)
        .setTitle('Select your resume (PDF)')
        .build();
      
      console.log('Picker created successfully:', picker);
      
      picker.setVisible(true);
    } catch (error) {
      console.error('Google Picker error:', error);
      console.error('Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace',
        type: typeof error,
        error: error
      });
      
      // Provide more specific error messages
      let errorMessage = 'Failed to open Google Drive picker. Please try again.';
      if (error instanceof Error) {
        if (error.message.includes('Google Picker API not available')) {
          errorMessage = 'Google Picker API is not loaded. Please ensure Google Picker API is enabled in your Google Cloud Console.';
        } else if (error.message.includes('timeout')) {
          errorMessage = 'Google API loading timeout. Please check your internet connection.';
        } else if (error.message.includes('API key')) {
          errorMessage = 'Invalid API key configuration. Please check your Google Drive API setup.';
        } else {
          errorMessage = error.message;
        }
      }
      
      toast({
        variant: 'destructive',
        title: 'Google Drive Error',
        description: errorMessage,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Handle file selection
  const pickerCallback = (data: any) => {
    console.log('Picker callback data:', data);
    
    if (data.action === window.google.picker.Action.PICKED) {
      const doc = data.docs[0];
      console.log('Selected document:', doc);
      
      // Convert Google Drive URL to direct download URL
      const fileUrl = doc.url || `https://drive.google.com/file/d/${doc.id}/view`;
      const fileName = doc.name;
      
      console.log('File selected:', { fileUrl, fileName });
      
      onFileSelect(fileUrl, fileName);
      
      toast({
        title: 'Resume Selected',
        description: `Selected: ${fileName}`,
      });
    }
  };

  // Simple fallback: open a read-only Google Drive file picker in a new tab
  const openSimpleDrivePicker = () => {
    const q = encodeURIComponent('mimeType="application/pdf"');
    const driveUrl = `https://drive.google.com/drive/search?q=${q}`;
    const win = window.open(driveUrl, 'gdrive', 'width=800,height=600');
    if (!win) {
      toast({ variant: 'destructive', title: 'Popup blocked', description: 'Please allow popups for this site.' });
      return;
    }
    // Poll for the selected file URL via postMessage or user copy-paste fallback
    const poll = setInterval(() => {
      if (win.closed) {
        clearInterval(poll);
        return;
      }
      win.postMessage({ type: 'REQUEST_SELECTED_FILE' }, 'https://drive.google.com');
    }, 1000);

    window.addEventListener('message', function handler(e) {
      if (e.origin !== 'https://drive.google.com') return;
      if (e.data && e.data.type === 'SELECTED_FILE') {
        clearInterval(poll);
        window.removeEventListener('message', handler);
        win.close();
        onFileSelect(e.data.url, e.data.name);
        toast({ title: 'Resume Selected', description: `Selected: ${e.data.name}` });
      }
    });
  };

  // Simple approach: Open Google Drive in new tab and let user copy file link
  const openDriveFilePicker = () => {
    setIsLoading(true);
    
    // Open Google Drive with PDF filter
    const driveUrl = 'https://drive.google.com/drive/search?q=mimeType%3D%22application%2Fpdf%22';
    const newWindow = window.open(driveUrl, '_blank', 'width=800,height=600');
    
    if (!newWindow) {
      toast({
        variant: 'destructive',
        title: 'Popup Blocked',
        description: 'Please allow popups for Google Drive file selection.',
      });
      setIsLoading(false);
      return;
    }
    
    // Show instructions to user
    toast({
      title: 'Select Your Resume',
      description: 'Please select your PDF file in Google Drive and copy the link, then paste it below.',
      duration: 10000,
    });
    
    // Create a simple input for pasting the Google Drive link
    const fileUrl = prompt('Please paste the Google Drive file link here:');
    
    if (fileUrl) {
      // Extract file ID from Google Drive URL
      const fileIdMatch = fileUrl.match(/[-\w]{25,}/);
      if (fileIdMatch) {
        const directUrl = `https://drive.google.com/file/d/${fileIdMatch[0]}/view`;
        onFileSelect(directUrl, 'Resume from Google Drive');
        toast({
          title: 'Resume Selected',
          description: 'Your Google Drive file has been selected successfully.',
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Invalid Link',
          description: 'Please paste a valid Google Drive file link.',
        });
      }
    }
    
    setIsLoading(false);
  };

  return (
    <Button
      onClick={openDriveFilePicker}
      disabled={disabled || isLoading}
      variant="outline"
      type="button"
    >
      {isLoading ? 'Opening Google Drive...' : 'Select from Google Drive'}
    </Button>
  );
}