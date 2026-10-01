'use client';

import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import { getFirestore, Firestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { getFunctions, Functions } from 'firebase/functions';
import { getStorage, FirebaseStorage } from 'firebase/storage';
import { firebaseConfig } from './config';

// Single source of truth for Firebase initialization to avoid cyclic imports
const firebaseApp: FirebaseApp = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const auth: Auth = getAuth(firebaseApp);
// Use getFirestore to avoid conflicting initialization during Hot Reload
const firestore: Firestore = getFirestore(firebaseApp);
const storage: FirebaseStorage = getStorage(firebaseApp);
const functions: Functions = getFunctions(firebaseApp);

export { firebaseApp, auth, firestore, storage, functions };
