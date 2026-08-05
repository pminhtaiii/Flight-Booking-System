/* eslint-disable @typescript-eslint/no-explicit-any */
import type { BookingDetailDto } from '@shared/booking-types';

export type BookingDetailProps = {
  booking: BookingDetailDto & {
    currentItinerary?: any;
    disruption?: any;
    payment?: { status: string } | null;
    bookingIntent?: { id: string; offerId: string };
  } | null;
  showConfirmation?: boolean;
  isMockEnabled?: boolean;
  bookingId?: string;
};

export const currencyFormatter = (amount: string, currency: string): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(Number(amount));
