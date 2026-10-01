/**
 * Audit logging system for SEDS Pakistan website
 */

import { doc, serverTimestamp, collection, query, orderBy, limit, getDocs, Firestore } from 'firebase/firestore';
;
import { v4 as uuidv4 } from 'uuid';
import { setDoc } from '@/lib/client/firestore-wrapper';

export interface AuditLogEntry {
  id: string;
  action: string;
  actorUid: string;
  targetUidOrResource: string;
  payload: any;
  timestamp: any;
  meta?: {
    clientIp?: string;
    userAgent?: string;
    isPreview?: boolean;
  };
}

/**
 * Log an audit entry
 * @param firestore The Firestore instance
 * @param action The action being performed
 * @param actorUid The UID of the user performing the action
 * @param targetUidOrResource The target of the action
 * @param payload Additional data about the action
 * @param meta Optional metadata
 */
export async function logAuditEntry(
  firestore: Firestore,
  action: string,
  actorUid: string,
  targetUidOrResource: string,
  payload: any,
  meta?: {
    clientIp?: string;
    userAgent?: string;
    isPreview?: boolean;
  }
): Promise<void> {
  // Remove undefined to prevent Firestore 400 (invalid-argument) on writes
  const sanitize = (obj: any): any => {
    if (obj === undefined) return undefined;
    if (obj === null) return null;
    if (Array.isArray(obj)) return obj.map(sanitize).filter((v) => v !== undefined);
    if (typeof obj === 'object') {
      const out: any = {};
      for (const [k, v] of Object.entries(obj)) {
        const sv = sanitize(v);
        if (sv !== undefined) out[k] = sv;
      }
      return out;
    }
    return obj;
  };

  console.log('📝 logAuditEntry - Starting audit logging:', {
    action,
    actorUid,
    targetUidOrResource,
    payloadKeys: Object.keys(payload || {}),
    hasMeta: !!meta
  });
  
  try {
    const auditLogRef = doc(collection(firestore, 'audit_logs'));
    const auditLogData: any = {
      action,
      actorUid,
      targetUidOrResource,
      ...(payload !== undefined ? { payload: sanitize(payload) } : {}),
      timestamp: serverTimestamp(),
    };

    if (meta) {
      const cleanedMeta = sanitize(meta);
      if (cleanedMeta && Object.keys(cleanedMeta).length > 0) {
        auditLogData.meta = cleanedMeta;
      }
      console.log('📝 logAuditEntry - Including metadata:', meta);
    }

    console.log('💾 logAuditEntry - Saving audit log to Firestore');
    await setDoc(auditLogRef, auditLogData);
    console.log('✅ logAuditEntry - Audit entry saved successfully:', auditLogRef.id);
  } catch (error) {
    console.error('❌ logAuditEntry - Error logging audit entry:', error);
    // We don't throw an error here because audit logging should not break the main flow
  }
}

/**
 * Get recent audit logs
 * @param firestore The Firestore instance
 * @param limitCount Number of logs to retrieve
 * @returns Array of recent audit logs
 */
export async function getRecentAuditLogs(firestore: Firestore, limitCount: number = 50): Promise<AuditLogEntry[]> {
  try {
    const auditLogsRef = collection(firestore, 'audit_logs');
    const q = query(auditLogsRef, orderBy('timestamp', 'desc'), limit(limitCount));
    const querySnapshot = await getDocs(q);
    
    return querySnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        action: data.action,
        actorUid: data.actorUid,
        targetUidOrResource: data.targetUidOrResource,
        payload: data.payload,
        timestamp: data.timestamp?.toDate() || new Date(),
        meta: data.meta,
      };
    });
  } catch (error) {
    // Downgrade permission errors to warnings to avoid noisy console errors on restricted roles
    const err: any = error;
    if (err && (err.code === 'permission-denied' || /Missing or insufficient permissions/i.test(err.message || ''))) {
      console.warn('Audit logs read denied by Firestore rules for this user/role. Returning empty list.');
    } else {
      console.error('Error fetching audit logs:', error);
    }
    return [];
  }
}

/**
 * Get audit logs for a specific user
 * @param firestore The Firestore instance
 * @param userUid The UID of the user
 * @param limitCount Number of logs to retrieve
 * @returns Array of audit logs for the user
 */
export async function getUserAuditLogs(firestore: Firestore, userUid: string, limitCount: number = 50): Promise<AuditLogEntry[]> {
  try {
    const auditLogsRef = collection(firestore, 'audit_logs');
    const q = query(
      auditLogsRef, 
      orderBy('timestamp', 'desc'), 
      limit(limitCount)
    );
    const querySnapshot = await getDocs(q);
    
    // Filter logs for the specific user
    const userLogs = querySnapshot.docs
      .map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          action: data.action,
          actorUid: data.actorUid,
          targetUidOrResource: data.targetUidOrResource,
          payload: data.payload,
          timestamp: data.timestamp?.toDate() || new Date(),
          meta: data.meta,
        };
      })
      .filter(log => log.actorUid === userUid);
    
    return userLogs;
  } catch (error) {
    console.error('Error fetching user audit logs:', error);
    return [];
  }
}
