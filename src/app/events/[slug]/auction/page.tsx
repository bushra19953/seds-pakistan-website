import type { Metadata } from 'next';
import AuctionClient from './_auction-client';

type Props = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Hardware Charity Auction | SEDS Pakistan`,
    description: `Bid on donated aerospace hardware lots for event ${slug}. All proceeds are 100 percent net operating margin supporting collegiate rocketry.`,
  };
}

// Server wrapper keeps metadata generation server-side; all bidding
// interactivity lives in the client component below.
export default async function EventAuctionPage({ params }: Props) {
  const { slug } = await params;
  return <AuctionClient eventId={slug} />;
}
