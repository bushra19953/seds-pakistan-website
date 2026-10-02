// Hardware Charity Auction types.
// $0 COGS fiscal engine: all lots are donated, so every accepted bid is
// 100 percent net operating margin for SEDS Pakistan.

/** A donated aerospace hardware lot in the charity auction catalog. */
export interface AuctionLot {
  /** Stable lot identifier, e.g. "lot-titanium-impeller". */
  id: string;
  /** Lot display title. */
  title: string;
  /** Lot description shown on the catalog card. */
  description: string;
  /** Donor factory name for reciprocal attribution. */
  donorFactory: string;
  /** Donor factory city/country. */
  donorLocation: string;
  /** Minimum acceptable bid. Bids below this floor are rejected. */
  reservePrice: number;
  /** Currency code for the reserve price and bids. */
  currency: 'PKR' | 'USD';
  /** Optional catalog image URL. */
  imageUrl?: string;
  /** Whether the donor carries the verified supplier badge. */
  supplierBadge: boolean;
  /** Link to the SEDS Sourcing Bridge profile or page for the donor. */
  sourcingBridgeUrl: string;
}

/** A bid placed on an auction lot. Written to the 'auction_bids' collection. */
export interface AuctionBid {
  /** Firestore document id (auto-generated). */
  id?: string;
  /** Lot this bid targets. */
  lotId: string;
  /** Event this auction belongs to. */
  eventId: string;
  /** Bidder Firebase UID. */
  bidderUid: string;
  /** Bidder display name. */
  bidderName: string;
  /** Bid amount in the lot currency. */
  amount: number;
  /** Currency code, copied from the lot at bid time. */
  currency: 'PKR' | 'USD';
  /** Whether this bid met or exceeded the lot reserve floor. */
  meetsReserve: boolean;
  /** Server timestamp of bid placement. */
  createdAt?: FirebaseFirestore.Timestamp;
}

/** Static catalog of donated lots (donor attribution per checklist spec). */
export const AUCTION_LOTS: AuctionLot[] = [
  {
    id: 'lot-titanium-impeller',
    title: '5-Axis CNC Titanium Impeller',
    description:
      'Precision 5-axis high-speed CNC machined titanium impeller, donated for the SEDS Pakistan hardware charity auction.',
    donorFactory: 'Sendottech',
    donorLocation: 'Dongguan, China',
    reservePrice: 150000,
    currency: 'PKR',
    supplierBadge: true,
    sourcingBridgeUrl: '/sourcing-bridge',
  },
  {
    id: 'lot-inconel-injector',
    title: 'SLM Inconel 718 Rocket Swirl Injector',
    description:
      'Selective laser melting (SLM) Inconel 718 rocket swirl injector, donated for the SEDS Pakistan hardware charity auction.',
    donorFactory: 'Yunzhu 3D',
    donorLocation: 'Shanghai, China',
    reservePrice: 220000,
    currency: 'PKR',
    supplierBadge: true,
    sourcingBridgeUrl: '/sourcing-bridge',
  },
  {
    id: 'lot-cubesat-frame',
    title: 'Space-Grade 3U CubeSat Structural Frame (Anodized)',
    description:
      'Anodized space-grade 3U CubeSat structural frame, donated for the SEDS Pakistan hardware charity auction.',
    donorFactory: 'SEDS Sourcing Bridge Network',
    donorLocation: 'China',
    reservePrice: 95000,
    currency: 'PKR',
    supplierBadge: true,
    sourcingBridgeUrl: '/sourcing-bridge',
  },
];

/** Look up a static lot by id. Returns undefined when unknown. */
export function getAuctionLot(lotId: string): AuctionLot | undefined {
  return AUCTION_LOTS.find((lot) => lot.id === lotId);
}
