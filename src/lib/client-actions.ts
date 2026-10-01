'use client';

import { collection, getFirestore, serverTimestamp } from 'firebase/firestore';
;
import { getFirebaseApp } from '@/firebase';
import { getAuth } from 'firebase/auth';
import { addDoc } from '@/lib/client/firestore-wrapper';


// Client-side project creation (extended fields to match admin capabilities)
export async function addProjectClient(data: {
  title: string;
  slug: string;
  description: string;
  imageUrl?: string;
  media?: string[];
  tags?: string[] | string; // accepts array or comma-separated
  status?: 'active' | 'completed' | 'archived' | 'draft';
  github_repo?: string;
  docs_url?: string;
  team?: string[];
  teamLeaderId?: string;
  projectUrl?: string;
}) {
  const auth = getAuth(getFirebaseApp());
  const firestore = getFirestore(getFirebaseApp());
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('You must be logged in to add a project');
  }

  const projectsCollection = collection(firestore, 'projects');

  // Normalize inputs
  const tagsArr = Array.isArray(data.tags)
    ? (data.tags as string[])
    : (data.tags || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
  const mediaArr = Array.isArray(data.media)
    ? (data.media as string[])
    : [];

  const projectData = {
    title: data.title,
    slug: data.slug,
    description: data.description,
    imageUrl: data.imageUrl || (mediaArr[0] || ''),
    media: mediaArr,
    projectUrl: data.projectUrl || '',
    tags: tagsArr,
    status: data.status || 'active',
    github_repo: data.github_repo || '',
    docs_url: data.docs_url || '',
    team: (data.team && data.team.length ? data.team : [currentUser.uid]),
    teamLeaderId: data.teamLeaderId || currentUser.uid,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  } as any;

  await addDoc(projectsCollection, projectData);
  return { success: true, message: `Project "${data.title}" has been added.` };
}

// AI features would require direct API integration
// For now, returning placeholder responses
export async function generateStudyGuideClient(topic: string) {
  // This would call Gemini API directly from client
  // For Spark plan, you'd need to use client-side API calls
  return {
    success: false,
    message: 'AI features require API configuration. Please set up your Gemini API key.',
    data: null
  };
}

export async function generateCopilotResponseClient(query: string) {
  // This would call Gemini API directly from client
  return {
    success: false,
    message: 'AI features require API configuration. Please set up your Gemini API key.',
    data: null
  };
}