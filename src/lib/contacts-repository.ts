import { Firestore, Query, collection, query, where, orderBy, limit, getDocs, getDoc, doc, serverTimestamp, Timestamp } from 'firebase/firestore';

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
 * Hard cap on the CRM page's Firestore FALLBACK query (getAllQuery).
 * The live read path is the Supabase seam poll (GET
 * /api/admin/partners/list, adapter keyset-paged, complete at any
 * collection size); this query fires only when the seam is off or has
 * failed. The cap bounds the worst-case Firestore read cost of that
 * fallback to 1,000 documents per activation instead of the whole
 * collection, matching the whole-collection admin reads elsewhere
 * (store order-management caps its users/products reads at 1000).
 */
export const CONTACTS_FALLBACK_LIMIT = 1000;

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
     * Bounded by CONTACTS_FALLBACK_LIMIT: this is the seam-failure
     * fallback only, never the primary read (see the constant above).
     */
    getAllQuery(): Query<PartnerRecord> {
        return query(
            partnersCollection(this.db),
            orderBy('updatedAt', 'desc'),
            limit(CONTACTS_FALLBACK_LIMIT)
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
     *
     * Routed through updatePartner -> PATCH /api/admin/partners (the same
     * consent-gated server path as every other partner write) instead of a
     * direct client updateDoc, which bypassed the sponsor_partner_flagged
     * consent gate. The API stamps updatedAt server-side. Field names are
     * top-level PartnerRecord keys; nested values are passed as whole
     * objects (e.g. primaryContact), matching the API's writable-field list.
     */
    async updateField(id: string, field: keyof PartnerRecord | string, value: any): Promise<void> {
        await updatePartner(this.db, id, { [field]: value } as Partial<PartnerRecord>);
    }

    /**
     * Update Status (Stage Move)
     *
     * Related-party guard (spec Part C 4.7, CH-19): a related-party record
     * must NOT be moved to Active through the generic stage control - that
     * is where the old bug lived. Activation runs the related-party gate
     * server-side through the maker-checker approvals flow
     * (targetType crm_status_active). The server gate is authoritative;
     * this client guard only fails fast.
     */
    async updateStage(id: string, newStage: PartnerRecord['status']): Promise<void> {
        if (newStage === 'Active') {
            const snap = await getDoc(doc(this.db, 'sponsors_partners', id));
            const data = snap.exists() ? (snap.data() as PartnerRecord) : null;
            if (data?.isRelatedParty) {
                throw new Error(
                    'Related-party records move to Active only through the approvals flow (crm_status_active), which runs the related-party gate.'
                );
            }
        }
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
