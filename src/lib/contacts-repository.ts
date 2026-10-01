import { Firestore, Query, collection, query, where, orderBy, limit, getDocs, doc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { updateDoc } from '@/lib/client/firestore-wrapper';

;
import {
    PartnerRecord,
    partnersCollection,
    createPartner,
    updatePartner,
    deletePartner,
    RelationshipStatus,
    Interaction,
    InteractionType,
    Direction
} from './partners';

/**
 * ContactsRepository
 * Single source of truth for CRM operations, wrapping the partners/sponsors collection.
 */
export class ContactsRepository {
    private db: Firestore;

    constructor(db: Firestore) {
        this.db = db;
    }

    /**
     * Get the base query for all contacts/opportunities, ordered by most recent update.
     */
    getAllQuery(): Query<PartnerRecord> {
        return query(
            partnersCollection(this.db),
            orderBy('updatedAt', 'desc')
        );
    }

    /**
     * Direct fetch (non-realtime) for specific filtering logic if needed.
     */
    async getOverdueFollowUps(): Promise<PartnerRecord[]> {
        const now = new Date();
        const q = query(
            partnersCollection(this.db),
            where('nextActionDate', '<', now.toISOString()),
            where('status', 'not-in', ['Closed', 'Past'])
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => d.data());
    }

    /**
     * Universal Update Method (Inline Edit)
     */
    async updateField(id: string, field: keyof PartnerRecord | string, value: any): Promise<void> {
        const docRef = doc(this.db, 'sponsors_partners', id);
        // Special case for primaryContact nested update handled by Firestore auto-merge if dot notation used
        // But here we are passing strict keys. For nested keys, we rely on the caller passing "primaryContact.name" as string key
        // or we expect the method to be called with a Partial<PartnerRecord> in updatePartner.
        await updateDoc(docRef, {
            [field]: value,
            updatedAt: serverTimestamp()
        });
    }

    /**
     * Update Status (Stage Move)
     */
    async updateStage(id: string, newStage: PartnerRecord['status']): Promise<void> {
        return this.update(this.db, id, {
            status: newStage,
            lastActivityAt: new Date().toISOString(),
            lastActivityType: `Stage: ${newStage}`
        });
    }

    /**
     * Log an interaction (Call, Email, Note) with full metadata
     */
    async addInteraction(
        id: string,
        currentTimeline: Interaction[] = [],
        entry: { type: InteractionType; direction: Direction; content: string; author: string }
    ): Promise<void> {
        // Create full interaction object
        const newInteraction: Interaction = {
            id: Math.random().toString(36).substring(2, 15),
            type: entry.type,
            direction: entry.direction,
            content: entry.content,
            author: entry.author,
            timestamp: new Date().toISOString() // Helper stores string, Firestore converts if needed or we stick to ISO
        };

        // Append to timeline
        const updatedTimeline = [...currentTimeline, newInteraction];

        // Derived updates
        const updates: Partial<PartnerRecord> = {
            timeline: updatedTimeline,
            lastContactAt: serverTimestamp(),
            lastActivityAt: new Date().toISOString(),
            lastActivityType: entry.type === 'note' ? 'Note Logged' : `${entry.type.charAt(0).toUpperCase() + entry.type.slice(1)} ${entry.direction === 'sent' ? 'Sent' : 'Received'}`,
            // Simple heuristic: bump score if it's a "received" message indicating engagement?
            // For now, let's just update the timeline.
            updatedAt: serverTimestamp()
        };

        await updatePartner(this.db, id, updates);
    }

    /**
     * Delete an interaction from the timeline
     */
    async deleteInteraction(id: string, currentTimeline: Interaction[], interactionId: string): Promise<void> {
        const updatedTimeline = currentTimeline.filter(i => i.id !== interactionId);

        // Recalculate lastContactAt if needed (safe/simple way: just take the last one of the new list if exists)
        let lastContactAt = null;
        if (updatedTimeline.length > 0) {
            const last = updatedTimeline[updatedTimeline.length - 1];
            lastContactAt = last.timestamp;
        }

        await updatePartner(this.db, id, {
            timeline: updatedTimeline,
            ...(lastContactAt ? { lastContactAt } : {})
        });
    }

    /**
     * Create a new partner/contact record
     */
    async createContact(data: PartnerRecord): Promise<string> {
        return createPartner(this.db, data);
    }

    // Wrappers for core CRUD
    create = createPartner;
    update = updatePartner;
    delete = deletePartner;
}
