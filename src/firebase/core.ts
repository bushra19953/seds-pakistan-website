'use client';

import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import { getFirestore, Firestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { getFunctions, Functions } from 'firebase/functions';
import { getStorage, FirebaseStorage } from 'firebase/storage';
import { firebaseConfig } from './config';
import {
  createDisabledFirestoreProxy,
  isFirestoreDataDisabled,
} from '@/lib/firestore-kill-switch';

// Single source of truth for Firebase initialization to avoid cyclic imports
const firebaseApp: FirebaseApp = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const auth: Auth = getAuth(firebaseApp);
// W5 kill-switch (client boundary): when NEXT_PUBLIC_FIRESTORE_DATA_DISABLED
// is baked ON, the exported Firestore handle is a throwing proxy — any
// data-path touch throws FirestoreDataDisabledError, loudly. Auth, Storage
// and Functions below are exempt and initialize exactly as before. When
// the flag is OFF this is the original getFirestore() call, unchanged.
// Use getFirestore to avoid conflicting initialization during Hot Reload
const firestore: Firestore = isFirestoreDataDisabled()
  ? createDisabledFirestoreProxy<Firestore>('client:firestore-instance')
  : getFirestore(firebaseApp);
const storage: FirebaseStorage = getStorage(firebaseApp);
const functions: Functions = getFunctions(firebaseApp);

export { firebaseApp, auth, firestore, storage, functions };
