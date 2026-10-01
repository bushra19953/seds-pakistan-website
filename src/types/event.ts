import type { Timestamp } from 'firebase/firestore';

export type EventStatus = 'draft' | 'scheduled' | 'published' | 'archived';
export type EventVisibility = 'public' | 'members' | 'private';
export type EventType = 'event' | 'workshop' | 'webinar';

export interface PaymentDetails {
  isPaid: boolean;
  amount?: number;
  currency?: string;
  method?: string;
  instructions?: string;
  qrCodeUrl?: string;
}

export interface StrategicFraming {
  lifestyleTargetHeadline?: string;
  lifestyleTargetExamples?: string[];
  incomeVehicleStatement?: string;
  dailyActionExample?: string;
  emotionalFraming?: {
    costOfInactionStatement?: string;
    freedomMetricsStatement?: string;
    socialImpactStatement?: string;
  };
  mindsetFraming?: {
    characterAmplifierStatement?: string;
    contributionCapacityStatement?: string;
    actionOverCriticismStatement?: string;
  };
}

export interface EventDoc {
  id?: string;
  title: string;
  slug: string;
  description?: string;
  valueProposition?: string;
  catalystStatement?: string;
  lifestyleOutcome?: string;
  type?: EventType;
  status: EventStatus;
  visibility?: EventVisibility;
  startAt: Timestamp;
  endAt?: Timestamp;
  isOnline?: boolean;
  location?: string;
  venue?: string;
  mapUrl?: string;
  tags?: string[];
  capacity?: number;
  registrationOpen?: boolean;
  paymentDetails?: PaymentDetails;
  strategicFraming?: StrategicFraming;
  attendeeIds?: string[];
  editors?: string[];
  createdByUid: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  imageUrl?: string;
  productId?: string;
  ticketImageUrl?: string;
  ticketBackImageUrl?: string;
  showInTicker?: boolean;
  priority?: number;
  ticketAssets?: {
    frontUrl?: string;
    backUrl?: string;
    lastUpdated?: Timestamp;
  };
  ticketConfig?: {
    frontOverlays?: {
      name?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      ticketNum?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      email?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      eventTitle: { x: number; y: number; size: number; color: string; enabled?: boolean };
      eventDate?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      eventVenue?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      logo?: { x: number; y: number; size: number; enabled?: boolean };
      orgName?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      orgTagline?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      issuedDate?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      statusBadge?: { x: number; y: number; size: number; enabled?: boolean };
      paymentRef?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      verificationUrl?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      disclaimer?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      qrCode?: { x: number; y: number; size: number; enabled?: boolean };
    };
    backOverlays?: {
      name?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      ticketNum?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      email?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      eventTitle?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      eventDate?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      eventVenue?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      logo?: { x: number; y: number; size: number; enabled?: boolean };
      orgName?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      orgTagline?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      issuedDate?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      statusBadge?: { x: number; y: number; size: number; enabled?: boolean };
      paymentRef?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      verificationUrl?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      disclaimer?: { x: number; y: number; size: number; color: string; enabled?: boolean };
      qrCode?: { x: number; y: number; size: number; enabled?: boolean };
    };
    lookFeel?: {
      theme?: string;
      texture?: string;
      atmosphere?: string;
    };
  };
}

export type RegistrationStatus = 'pending' | 'under_review' | 'confirmed' | 'cancelled';
export type PaymentStatus = 'unpaid' | 'pending' | 'verified' | 'refunded';

export interface EventRegistrationDoc {
  uid: string; // same as document id
  eventId: string;
  transactionId?: string; // Links to the Store Order
  displayName?: string;
  email?: string;
  whatsappE164?: string;
  status: RegistrationStatus;
  paymentStatus: PaymentStatus;
  paymentMethod?: string;
  paymentRef?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}