import { complementStoredOfferPayload } from './stored-offer-payload.helper';

describe('complementStoredOfferPayload', () => {
  it.each(['invalid-date', new Date(Number.NaN)])(
    'does not fill segment dates when the stored departure date is invalid (%s)',
    (departureDate) => {
      const rawOffer = { slices: [{ segments: [{ id: 'outbound' }] }] };

      expect(complementStoredOfferPayload(rawOffer, { departureDate })).toEqual(rawOffer);
    },
  );

  it('fills missing outbound dates while preserving existing and return segment dates', () => {
    const rawOffer = {
      slices: [
        {
          segments: [
            { id: 'outbound-missing' },
            { id: 'outbound-existing', departing_at: '2026-10-01T12:00:00' },
          ],
        },
        {
          segments: [
            { id: 'return-missing' },
            { id: 'return-existing', departing_at: '2026-10-10T15:00:00' },
          ],
        },
      ],
    };

    expect(complementStoredOfferPayload(rawOffer, { departureDate: '2026-10-01' })).toEqual({
      slices: [
        {
          segments: [
            { id: 'outbound-missing', departing_at: '2026-10-01T00:00:00.000Z' },
            { id: 'outbound-existing', departing_at: '2026-10-01T12:00:00' },
          ],
        },
        {
          segments: [
            { id: 'return-missing' },
            { id: 'return-existing', departing_at: '2026-10-10T15:00:00' },
          ],
        },
      ],
    });
    expect(rawOffer.slices[0].segments[0]).toEqual({ id: 'outbound-missing' });
  });
});
