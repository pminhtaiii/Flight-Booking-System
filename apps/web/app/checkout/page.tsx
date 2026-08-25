import { redirect } from 'next/navigation';

const LOCAL_OFFER_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

type Props = {
  searchParams: {
    offerId?: string | string[];
  };
};

export default function CheckoutPage({ searchParams }: Props): never {
  const offerId = searchParams.offerId;
  if (!isLocalOfferId(offerId)) redirect('/search');

  redirect(`/checkout/passengers?offerId=${encodeURIComponent(offerId)}`);
}

function isLocalOfferId(offerId: string | string[] | undefined): offerId is string {
  return (
    typeof offerId === 'string' &&
    LOCAL_OFFER_ID_PATTERN.test(offerId) &&
    !offerId.toLowerCase().startsWith('off_')
  );
}
