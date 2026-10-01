import { Firestore, collection, doc, getDocs, query, where, serverTimestamp, Timestamp } from 'firebase/firestore';
import { setDoc, deleteDoc } from '@/lib/client/firestore-wrapper';

;

export interface Principle {
    id?: string;
    title: string;
    source: string; // e.g., "48 Laws of Power", "Cialdini", "Custom"
    category: 'Power' | 'Psychology' | 'Business' | 'Ethics' | 'Strategy';
    content: string;
    active: boolean;
    tags?: string[];
    createdAt?: any;
    updatedAt?: any;
}

export const DEFAULT_PRINCIPLES: Principle[] = [
    {
        title: "Law 1: Never Outshine the Master",
        source: "48 Laws of Power",
        category: "Power",
        content: "Always make those above you feel comfortably superior. In your desire to please or impress them, do not go too far in displaying your talents or you might accomplish the opposite – inspire fear and insecurity. Make your masters appear more brilliant than they are and you will attain the heights of power.",
        active: true,
        tags: ["ego", "authority", "caution"]
    },
    {
        title: "Law 3: Conceal Your Intentions",
        source: "48 Laws of Power",
        category: "Power",
        content: "Keep people off-balance and in the dark by never revealing the purpose behind your actions. If they have no clue what you are up to, they cannot prepare a defense. Guide them far down the wrong path, envelop them in enough smoke, and by the time they realize your intentions, it will be too late.",
        active: true,
        tags: ["secrecy", "strategy", "misdirection"]
    },
    {
        title: "Reciprocity",
        source: "Influence (Cialdini)",
        category: "Psychology",
        content: "People are obliged to give back to others the form of behavior, gift, or service that they have received first. If a friend invites you to their party, there's an obligation for you to invite them to a future party you are hosting. If a colleague does you a favor, then you owe that colleague a favor. And in the context of a social obligation people are more likely to say yes to those who they owe.",
        active: true,
        tags: ["persuasion", "negotiation"]
    }
];

export class PrinciplesRepository {
    private db: Firestore;

    constructor(db: Firestore) {
        this.db = db;
    }

    private getCollection(userId: string) {
        return collection(this.db, `users/${userId}/principles`);
    }

    async create(userId: string, principle: Principle): Promise<string> {
        const ref = doc(this.getCollection(userId));
        const id = ref.id;
        await setDoc(ref, {
            ...principle,
            id,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        return id;
    }

    async update(userId: string, id: string, updates: Partial<Principle>): Promise<void> {
        const ref = doc(this.db, `users/${userId}/principles/${id}`);
        await setDoc(ref, { ...updates, updatedAt: serverTimestamp() }, { merge: true });
    }

    async delete(userId: string, id: string): Promise<void> {
        const ref = doc(this.db, `users/${userId}/principles/${id}`);
        await deleteDoc(ref);
    }

    async getAll(userId: string): Promise<Principle[]> {
        const q = query(this.getCollection(userId));
        const snap = await getDocs(q);
        return snap.docs.map(d => d.data() as Principle);
    }

    async getActive(userId: string): Promise<Principle[]> {
        const q = query(this.getCollection(userId), where('active', '==', true));
        const snap = await getDocs(q);
        return snap.docs.map(d => d.data() as Principle);
    }

    async seedDefaults(userId: string): Promise<void> {
        const current = await this.getAll(userId);
        if (current.length > 0) return; // Don't overwrite if exists

        for (const p of DEFAULT_PRINCIPLES) {
            await this.create(userId, p);
        }
    }
}
