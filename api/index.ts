import { App, getApps, initializeApp, cert } from 'firebase-admin/app';
import { Auth, getAuth } from 'firebase-admin/auth';
import { Firestore, getFirestore, FieldValue } from 'firebase-admin/firestore';
import cors from 'cors';

// Vercel Serverless Function signature
export default async function handler(req: any, res: any) {
  // CORS configuration
  const runCors = cors({ origin: true });
  
  await new Promise((resolve, reject) => {
    runCors(req as any, res as any, (result) => {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });

  try {
    // 1. Initialize Firebase Admin SDK
    if (!getApps().length) {
      if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is not set.');
      }
      
      let saData = process.env.FIREBASE_SERVICE_ACCOUNT;
      let serviceAccount;
      try {
        serviceAccount = JSON.parse(saData);
        if (typeof serviceAccount === 'string') serviceAccount = JSON.parse(serviceAccount);
      } catch (e) {
        serviceAccount = JSON.parse(saData.replace(/\\n/g, '\n'));
      }

      initializeApp({
        credential: cert(serviceAccount),
      });
      console.log('✅ Firebase Admin initialized from ENV');
    }
  } catch (error) {
    console.error('💥 [API] Admin Initialization failed:', error);
    return res.status(500).json({ error: 'Internal Server Error: Admin SDK Init Failed' });
  }

  try {
    // Normalize path (remove leading/trailing slashes). Vercel provides req.url
    const path = req.query.path || req.url?.split('?')[0].replace(/^\/+|\/+$/g, '') || '';
    
    // We expect the proxy in firebase.json to send requests directly, or we can check the path parameter
    let finalPath = path;
    if (finalPath.startsWith('api/')) finalPath = finalPath.replace('api/', '');
    
    if (finalPath === 'proxyImage') {
      return await handleProxyImage(req, res);
    }
    if (finalPath === 'leaderboardAggregate' || finalPath === 'onLeaderboardAggregate') {
      return await handleLeaderboardAggregate(req, res);
    }
    if (finalPath === 'checkPositionContinuity') {
      return await handleCallableDispatcher(req, res, handleCheckPositionContinuity);
    }
    if (finalPath === 'registerForEvent') {
      return await handleCallableDispatcher(req, res, handleRegisterForEvent);
    }

    return res.status(404).json({ error: 'Endpoint not found or not migrated to unified API yet.' });
  } catch (error) {
    console.error('💥 [API ROUTER] Uncaught Error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

// ----------------------------------------------------------------------------
// HANDLERS
// ----------------------------------------------------------------------------

async function handleProxyImage(req: any, res: any) {
  try {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'URL parameter is required' });
      return;
    }

    // Only allow Google profile images and other trusted sources
    const allowedDomains = [
      'lh3.googleusercontent.com',
      'lh4.googleusercontent.com',
      'lh5.googleusercontent.com',
      'lh6.googleusercontent.com',
      'googleusercontent.com',
      'firebasestorage.googleapis.com'
    ];

    const isAllowed = allowedDomains.some(domain => url.includes(domain));
    if (!isAllowed) {
      res.status(403).json({ error: 'Domain not allowed' });
      return;
    }

    // Fetch the image
    const imageResponse = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEDS-Pakistan-Proxy/1.0)'
      }
    });

    if (!imageResponse.ok) {
      res.status(404).json({ error: 'Image not found' });
      return;
    }

    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = await imageResponse.arrayBuffer();

    // Set appropriate headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Send the image
    res.status(200).send(Buffer.from(imageBuffer));

  } catch (error) {
    console.error('Image proxy error:', error);
    res.status(500).json({ error: 'Failed to proxy image' });
  }
}

async function handleCallableDispatcher(req: any, res: any, handler: (data: any, auth: any) => Promise<any>) {
  try {
    // 1. Verify Authentication
    const authHeader = req.headers.authorization;
    let auth = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const idToken = authHeader.split('Bearer ')[1];
      try {
        const decodedToken = await getAuth().verifyIdToken(idToken);
        auth = { uid: decodedToken.uid, token: decodedToken };
      } catch (e) {
        console.warn('⚠️ [API] Invalid token provided to callable route:', req.url);
      }
    }

    // 2. Extract Data (Expects { data: ... })
    const data = req.body?.data || req.query || {};

    // 3. Execute Handler
    const result = await handler(data, auth);

    // 4. Return formatted response (onCall protocol: { result: ... })
    return res.status(200).json({ result });
  } catch (error: any) {
    console.error(`💥 [API] Callable handler failed at ${req.url}:`, error);
    const status = error.code || 'internal';
    const message = error.message || 'Internal error';
    const httpStatus = 400; // Simplified for Vercel
    return res.status(httpStatus).json({ error: { status, message } });
  }
}

async function handleLeaderboardAggregate(req: any, res: any) {
  try {
    const db = getFirestore();
    const { page = 1, pageSize = 10, chapterId } = req.query;

    console.log('🏆 [AGGREGATION] Starting leaderboard aggregation', { page, pageSize, chapterId });

    const pageNum = parseInt(page as string) || 1;
    const size = Math.min(parseInt(pageSize as string) || 10, 50); // Max 50 per page
    const offset = (pageNum - 1) * size;

    // Build the query
    let query = db.collection('users') as any;

    if (chapterId && typeof chapterId === 'string') {
      query = query.where('chapterId', '==', chapterId);
    }

    // Get paginated results
    const snapshot = await query
      .orderBy('points', 'desc')
      .offset(offset)
      .limit(size)
      .get();

    // Process the aggregated data
    const rawUsers = snapshot.docs.map((doc: any) => {
      const data = doc.data();
      return {
        id: doc.id,
        displayName: data.displayName || data.name || data.email || 'Anonymous',
        email: data.email || '',
        photoURL: data.photoURL || undefined,
        points: Number(data.points || 0),
        totalHoursWorked: Number(data.totalHoursWorked || 0),
        chapterId: data.chapterId || undefined,
        tasksAssignedCount: Number(data.tasksAssignedCount || 0),
        tasksCompletedOnTimeCount: Number(data.tasksCompletedOnTimeCount || 0),
        university: data.university || undefined,
        upvotes: Number(data.upvotes || 0),
        downvotes: Number(data.downvotes || 0),
        badges: Array.isArray(data.badges) ? data.badges.slice(0, 5) : [],
        role: data.displayRole || null,
        isOnVacation: data.isOnVacation || false,
      };
    });

    const chapterIds = Array.from(new Set(rawUsers.map((u: any) => u.chapterId).filter(Boolean))) as string[];
    const chapterNameMap: Record<string, string> = {};
    if (chapterIds.length > 0) {
      const snaps = await Promise.all(chapterIds.map(id => db.collection('chapters').doc(id).get()));
      snaps.forEach((snap, idx) => {
        if (snap.exists) {
          const d = snap.data() as any;
          chapterNameMap[chapterIds[idx]] = String(d?.name || d?.title || '');
        }
      });
    }

    const users = rawUsers.map((u: any) => ({
      ...u,
      chapter: u.chapterId ? { name: chapterNameMap[u.chapterId] || '' } : undefined,
    }));

    const totalUsersQuery = chapterId
      ? db.collection('users').where('chapterId', '==', chapterId)
      : db.collection('users');

    const totalUsersCountSnap = await totalUsersQuery.count().get();
    const totalUsers = totalUsersCountSnap.data().count;

    const totalPages = Math.ceil(totalUsers / size);
    const hasNext = pageNum < totalPages;
    const hasPrev = pageNum > 1;

    const result = {
      users,
      pagination: {
        page: pageNum,
        pageSize: size,
        totalUsers,
        totalPages,
        hasNext,
        hasPrev,
      },
      timestamp: new Date().toISOString(),
    };

    console.log('🏆 [AGGREGATION] Aggregation completed', { usersCount: users.length, page: pageNum });

    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    res.status(200).json(result);

  } catch (error: any) {
    console.error('❌ [AGGREGATION] Leaderboard aggregation failed:', error);
    res.status(500).json({
      error: 'Failed to aggregate leaderboard data',
      message: error.message || 'Unknown error'
    });
  }
}

async function handleCheckPositionContinuity(data: any, auth: any) {
  const db = getFirestore();
  const uid = auth?.uid;

  if (!uid) {
    throw new Error('unauthenticated: User must be signed in');
  }

  try {
    console.log('🔧 [POSITION] Manual continuity check requested by:', uid);

    const positionsQuery = await db.collection('positions').where('endDate', '==', null).get();
    const positionsByRole: Record<string, any[]> = {};

    positionsQuery.docs.forEach(doc => {
      const position = doc.data();
      const role = position.role;
      if (!positionsByRole[role]) {
        positionsByRole[role] = [];
      }
      positionsByRole[role].push({ id: doc.id, ...position });
    });

    const issues = [];
    for (const [role, positions] of Object.entries(positionsByRole)) {
      if (positions.length > 1) {
        issues.push({
          role,
          currentPositions: positions.length,
          positionIds: positions.map(p => p.id)
        });
      }
    }

    return {
      success: true,
      message: issues.length === 0 ? 'No continuity issues found' : 'Continuity issues detected',
      issues: issues,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('❌ [POSITION] Manual continuity check failed:', error);
    throw new Error('internal: Failed to perform continuity check');
  }
}

async function handleRegisterForEvent(data: any, auth: any) {
  const db = getFirestore();
  const uid = auth?.uid;

  if (!uid) {
    throw new Error('unauthenticated: User must be signed in');
  }
  const eventId = typeof data?.eventId === 'string' ? data.eventId.trim() : '';
  if (!eventId) {
    throw new Error('invalid-argument: eventId is required');
  }

  try {
    await db.runTransaction(async (tx) => {
      const eventRef = db.collection('events').doc(eventId);
      const regRef = eventRef.collection('registrations').doc(uid);
      const userRef = db.collection('users').doc(uid);

      const [eventSnap, regSnap, userSnap] = await Promise.all([
        tx.get(eventRef),
        tx.get(regRef),
        tx.get(userRef),
      ]);

      if (!eventSnap.exists) {
        throw new Error('not-found: Event not found');
      }
      const event = eventSnap.data() as any;
      const capacity = Number(event?.capacity || 0);
      const registrationOpen = !!event?.registrationOpen;
      const status = String(event?.status || event?.published ? 'published' : 'draft');
      const attendeeIds: string[] = Array.isArray(event?.attendeeIds) ? event.attendeeIds.filter((x: any) => typeof x === 'string') : [];

      if (!registrationOpen || status !== 'published') {
        throw new Error('failed-precondition: Registration is closed for this event');
      }

      if (regSnap.exists) {
        const existing = regSnap.data() as any;
        const st = String(existing?.status || 'pending');
        if (st !== 'cancelled') {
          return; // Already registered
        }
      }

      const currentCount = attendeeIds.length;
      if (capacity && currentCount >= capacity) {
        throw new Error('failed-precondition: Sorry, this event is full');
      }

      const now = new Date();
      const displayName = userSnap.exists ? (userSnap.data() as any)?.displayName || null : null;
      const email = userSnap.exists ? (userSnap.data() as any)?.email || null : null;
      const whatsappE164 = typeof data?.whatsappE164 === 'string' ? data.whatsappE164 : null;
      const isPaidEvent = !!(event?.paymentDetails?.isPaid === true);
      const paymentMethod = typeof data?.paymentMethod === 'string' ? data.paymentMethod : (event?.paymentDetails?.method || null);

      tx.update(eventRef, {
        attendeeIds: FieldValue.arrayUnion(uid) as any,
        registrationsCount: FieldValue.increment(1) as any,
        updatedAt: now,
      });

      tx.set(regRef, {
        uid,
        eventId,
        displayName,
        email,
        whatsappE164,
        status: 'pending',
        paymentStatus: isPaidEvent ? 'unpaid' : 'verified',
        paymentMethod,
        paymentRef: null,
        createdAt: now,
        updatedAt: now,
      }, { merge: true });
    });
    return { ok: true };
  } catch (error: any) {
    const msg = typeof error?.message === 'string' ? error.message : 'Registration failed';
    throw new Error('unknown: ' + msg);
  }
}
