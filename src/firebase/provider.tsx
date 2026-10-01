'use client';

import { createContext, useContext, useMemo, ReactNode } from 'react';
import { Auth } from 'firebase/auth';
import { Firestore } from 'firebase/firestore';
import { FirebaseStorage } from 'firebase/storage';
import { FirebaseApp } from 'firebase/app';
import { auth, firestore, storage, firebaseApp } from './core';

interface FirebaseContextType {
  firebaseApp: FirebaseApp;
  auth: Auth;
  firestore: Firestore;
  storage: FirebaseStorage;
}

const FirebaseContext = createContext<FirebaseContextType | undefined>(undefined);

export const FirebaseProvider = ({ children }: { children: ReactNode }) => {
  const firebase = useMemo(() => {
    // Removed setPersistence call as it's causing compatibility issues
    // Auth persistence will use the default browser local storage
    return { firebaseApp, auth, firestore, storage };
  }, []);

  return <FirebaseContext.Provider value={firebase}>{children}</FirebaseContext.Provider>;
};

export const useFirebase = () => {
  const context = useContext(FirebaseContext);
  if (context === undefined) {
    throw new Error('useFirebase must be used within a FirebaseProvider');
  }
  return context;
};

export const useFirebaseApp = () => useFirebase().firebaseApp;
export const useAuth = () => useFirebase().auth;
export const useFirestore = () => useFirebase().firestore;
export const useStorage = () => useFirebase().storage;

export const getFirebaseApp = () => firebaseApp;
export const getAuthService = () => auth;
export const getFirestoreService = () => firestore;
export const getStorageService = () => storage;
