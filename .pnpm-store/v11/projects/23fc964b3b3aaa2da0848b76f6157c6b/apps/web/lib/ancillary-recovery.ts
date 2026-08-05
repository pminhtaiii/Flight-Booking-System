type RecoverySeat = {
  intentPassengerId: string;
  segmentId: string;
  serviceId: string;
  seatDesignator: string;
};

type RecoveryBaggage = {
  intentPassengerId: string;
  serviceId: string;
  quantity: number;
};

export type AncillaryRecoveryRecord = {
  schemaVersion: 1;
  intentId: string;
  selectionId: string;
  selectionVersion: number;
  updatedAt: string;
  expiresAt: string;
  seats: RecoverySeat[];
  baggage: RecoveryBaggage[];
};

type AncillaryRecoveryInput = Omit<AncillaryRecoveryRecord, 'schemaVersion' | 'expiresAt'> & {
  intentExpiresAt: string;
};

type StorageWriter = {
  setItem(key: string, value: string): void;
};

export function ancillaryRecoveryKey(intentId: string): string {
  return `checkout:ancillary-recovery:${intentId}`;
}

export function writeAncillaryRecovery(storage: StorageWriter, input: AncillaryRecoveryInput): void {
  const record: AncillaryRecoveryRecord = {
    schemaVersion: 1,
    intentId: input.intentId,
    selectionId: input.selectionId,
    selectionVersion: input.selectionVersion,
    updatedAt: input.updatedAt,
    expiresAt: input.intentExpiresAt,
    seats: input.seats,
    baggage: input.baggage,
  };

  storage.setItem(ancillaryRecoveryKey(input.intentId), JSON.stringify(record));
}

