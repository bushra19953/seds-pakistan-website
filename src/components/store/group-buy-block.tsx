/**
 * GroupBuyBlock: GH owns the contents of this component (team open,
 * join, and share behaviour, spec Section 6). GD creates the file
 * with the frozen props contract below; GH replaces the body without
 * changing the props. Until then it renders null, so no placeholder
 * group-buy UI ever reaches a buyer.
 */
export function GroupBuyBlock(props: {
  productId: string;
  productName: string;
  unitPricePkr: number;
  teamSize: number | null;
  windowHours: number | null;
}) {
  void props;
  return null;
}

export default GroupBuyBlock;
