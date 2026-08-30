export type BookingStatus =
  | 'PROCESSING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'COMPLETED'
  | 'CANCELLATION_PENDING'
  | 'CANCELLED_PENDING_REFUND'
  | 'CANCELLED_AND_REFUNDED'
  | 'CANCELLED_NO_REFUND'
  | 'REFUND_FAILED_NEEDS_ATTENTION';

type BookingStatusBadgeProps = {
  status: BookingStatus;
};

const statusStyles: Record<BookingStatus, string> = {
  PROCESSING: 'bg-bg-pending text-text-pending',
  CONFIRMED: 'bg-bg-confirmed text-text-confirmed',
  FAILED: 'bg-bg-cancelled text-text-cancelled',
  COMPLETED: 'bg-background text-text-secondary border border-border-primary',
  CANCELLATION_PENDING: 'bg-bg-pending text-text-pending',
  CANCELLED_PENDING_REFUND: 'bg-bg-pending text-text-pending',
  CANCELLED_AND_REFUNDED: 'bg-bg-cancelled text-text-cancelled',
  CANCELLED_NO_REFUND: 'bg-bg-cancelled text-text-cancelled',
  REFUND_FAILED_NEEDS_ATTENTION: 'bg-bg-cancelled text-text-cancelled border border-danger-border',
};

const statusLabels: Record<BookingStatus, string> = {
  PROCESSING: 'Processing',
  CONFIRMED: 'Confirmed',
  FAILED: 'Failed',
  COMPLETED: 'Completed',
  CANCELLATION_PENDING: 'Cancellation Pending',
  CANCELLED_PENDING_REFUND: 'Refund Pending',
  CANCELLED_AND_REFUNDED: 'Cancelled & Refunded',
  CANCELLED_NO_REFUND: 'Cancelled',
  REFUND_FAILED_NEEDS_ATTENTION: 'Refund Failed',
};

export function BookingStatusBadge({ status }: BookingStatusBadgeProps) {
  return (
    <span
      className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[status] || 'bg-background text-text-secondary'}`}
    >
      {statusLabels[status] || status}
    </span>
  );
}
