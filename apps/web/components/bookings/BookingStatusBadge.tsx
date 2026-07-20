type BookingStatusBadgeProps = {
  status: 'PROCESSING' | 'CONFIRMED' | 'FAILED' | 'COMPLETED';
};

const statusStyles = {
  PROCESSING: 'bg-bg-pending text-text-pending',
  CONFIRMED: 'bg-bg-confirmed text-text-confirmed',
  FAILED: 'bg-bg-cancelled text-text-cancelled',
  COMPLETED: 'bg-background text-text-secondary',
} as const;

const statusLabels = {
  PROCESSING: 'Processing',
  CONFIRMED: 'Confirmed',
  FAILED: 'Failed',
  COMPLETED: 'Completed',
} as const;

export function BookingStatusBadge({ status }: BookingStatusBadgeProps) {
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[status]}`}>
      {statusLabels[status]}
    </span>
  );
}
