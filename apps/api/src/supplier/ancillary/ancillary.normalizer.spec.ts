import { Test } from '@nestjs/testing';
import type { AncillaryCatalog } from '@shared/types';
import { AncillaryNormalizer } from './ancillary.normalizer';

function normalizeSeatSections(
  normalizer: AncillaryNormalizer,
  sections: unknown[],
): AncillaryCatalog {
  return normalizer.normalizeCatalog(
    [
      {
        segment_id: 'seg_1',
        cabins: [
          {
            cabin_class: 'economy',
            rows: [{ row_number: 1, sections }],
          },
        ],
      },
    ],
    {
      slices: [
        {
          segments: [
            {
              id: 'seg_1',
              origin: { iata_code: 'SGN' },
              destination: { iata_code: 'SIN' },
            },
          ],
        },
      ],
    },
  );
}

describe('AncillaryNormalizer', () => {
  let normalizer: AncillaryNormalizer;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    const module = await Test.createTestingModule({
      providers: [AncillaryNormalizer],
    }).compile();
    normalizer = module.get(AncillaryNormalizer);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('maps an offer segment to its seat map and projects each seat element', () => {
    const offer = {
      slices: [
        {
          segments: [
            {
              id: 'seg_1',
              origin: { iata_code: 'SGN' },
              destination: { iata_code: 'SIN' },
            },
          ],
        },
      ],
    };
    const maps = [
      {
        segment_id: 'seg_1',
        cabins: [
          {
            cabin_class: 'economy',
            rows: [
              {
                row_number: 1,
                sections: [
                  {
                    elements: [
                      {
                        type: 'seat',
                        designator: '1A',
                        disclosures: ['restricted'],
                        available_services: [
                          {
                            id: 'seat_1',
                            passenger_id: 'pas_1',
                            total_amount: '15.00',
                            total_currency: 'USD',
                          },
                        ],
                      },
                      { type: 'aisle' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(normalizer.normalizeCatalog(maps, offer).segments[0]).toEqual({
      segmentId: 'seg_1',
      origin: 'SGN',
      destination: 'SIN',
      seatMapAvailable: true,
      seatMap: {
        cabins: [
          {
            cabinClass: 'economy',
            rows: [
              {
                rowNumber: 1,
                elements: [
                  {
                    type: 'seat',
                    designator: '1A',
                    restricted: true,
                    availableServices: [
                      {
                        serviceId: 'seat_1',
                        passengerId: 'pas_1',
                        amount: '15.00',
                        currency: 'USD',
                      },
                    ],
                  },
                  { type: 'aisle' },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it('returns missing seat-map state with deterministic catalog metadata', () => {
    const catalog = normalizer.normalizeCatalog(null, {
      slices: [
        {
          segments: [
            {
              id: 'seg_1',
              origin: { iata_code: 'SGN' },
              destination: { iata_code: 'SIN' },
            },
          ],
        },
      ],
    });

    expect(catalog).toEqual({
      fetchedAt: '2026-10-01T00:00:00.000Z',
      cache: { status: 'MISS', ttlSeconds: 60 },
      segments: [
        {
          segmentId: 'seg_1',
          origin: 'SGN',
          destination: 'SIN',
          seatMapAvailable: false,
          seatMap: null,
        },
      ],
      baggageServices: [],
    });
  });

  it('ignores malformed nested supplier collections safely', () => {
    const catalog = normalizer.normalizeCatalog(
      { segment_id: 'seg_1' },
      {
        slices: [
          null,
          { segments: [null, { id: 1, origin: null, destination: { iata_code: 'SIN' } }] },
        ],
        available_services: null,
      },
    );

    expect(catalog.segments).toEqual([]);
    expect(catalog.baggageServices).toEqual([]);
  });

  it('keeps only seat services with every supplier identity and price field', () => {
    const complete = {
      id: 'seat_1',
      passenger_id: 'pas_1',
      total_amount: '15.00',
      total_currency: 'USD',
    };
    const catalog = normalizer.normalizeCatalog(
      [
        {
          segment_id: 'seg_1',
          cabins: [
            {
              cabin_class: 'economy',
              rows: [
                {
                  row_number: 1,
                  sections: [
                    {
                      elements: [
                        {
                          type: 'seat',
                          available_services: [
                            complete,
                            {
                              passenger_id: 'pas_1',
                              total_amount: '15.00',
                              total_currency: 'USD',
                            },
                            {
                              id: 'seat_1',
                              total_amount: '15.00',
                              total_currency: 'USD',
                            },
                            {
                              id: 'seat_1',
                              passenger_id: 'pas_1',
                              total_currency: 'USD',
                            },
                            {
                              id: 'seat_1',
                              passenger_id: 'pas_1',
                              total_amount: '15.00',
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      {
        slices: [
          {
            segments: [
              {
                id: 'seg_1',
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'SIN' },
              },
            ],
          },
        ],
      },
    );

    expect(catalog.segments[0].seatMap?.cabins[0].rows[0].elements[0].availableServices).toEqual([
      {
        serviceId: 'seat_1',
        passengerId: 'pas_1',
        amount: '15.00',
        currency: 'USD',
      },
    ]);
  });

  it('marks a seat unrestricted when its disclosures omit restricted', () => {
    const catalog = normalizeSeatSections(normalizer, [
      { elements: [{ type: 'seat', disclosures: ['window'] }] },
    ]);

    expect(catalog.segments[0].seatMap?.cabins[0].rows[0].elements[0]).toEqual({
      type: 'seat',
      restricted: false,
      availableServices: [],
    });
  });

  it('flattens seat-map sections in their supplier order', () => {
    const catalog = normalizeSeatSections(normalizer, [
      {
        elements: [
          { type: 'seat', designator: '1A' },
          { type: 'aisle' },
        ],
      },
      { elements: [{ type: 'seat', designator: '1B' }] },
    ]);

    expect(catalog.segments[0].seatMap?.cabins[0].rows[0].elements).toEqual([
      { type: 'seat', designator: '1A', restricted: false, availableServices: [] },
      { type: 'aisle' },
      { type: 'seat', designator: '1B', restricted: false, availableServices: [] },
    ]);
  });

  it('projects baggage services once for each passenger with supplier pricing', () => {
    const catalog = normalizer.normalizeCatalog([], {
      available_services: [
        {
          id: 'bag_1',
          type: 'baggage',
          passenger_ids: ['pas_1', 'pas_2'],
          segment_ids: ['seg_1'],
          total_amount: '30.00',
          total_currency: 'USD',
          metadata: {
            type: 'checked',
            weight: 23,
            weight_unit: 'kg',
            maximum_quantity: 2,
          },
        },
      ],
    });

    expect(catalog.baggageServices).toEqual(
      ['pas_1', 'pas_2'].map((passengerId) => ({
        serviceId: 'bag_1',
        passengerId,
        segmentIds: ['seg_1'],
        type: 'checked',
        weightValue: 23,
        weightUnit: 'kg',
        maxQuantity: 2,
        amount: '30.00',
        currency: 'USD',
      })),
    );
  });

  it('quarantines baggage services with incomplete identities or prices', () => {
    const valid = {
      id: 'bag_valid',
      type: 'baggage',
      passenger_ids: ['pas_1'],
      segment_ids: ['seg_1'],
      total_amount: '30.00',
      total_currency: 'USD',
      metadata: {
        type: 'checked',
        weight: 23,
        weight_unit: 'kg',
        maximum_quantity: 2,
      },
    };
    const catalog = normalizer.normalizeCatalog([], {
      available_services: [
        valid,
        { ...valid, id: '' },
        { ...valid, total_amount: '' },
        { ...valid, total_currency: '' },
        { ...valid, passenger_ids: [''] },
        { ...valid, passenger_ids: [] },
        { ...valid, passenger_ids: undefined },
        { ...valid, segment_ids: [''] },
        { ...valid, segment_ids: [] },
        { ...valid, segment_ids: undefined },
        { ...valid, metadata: { ...valid.metadata, type: '' } },
        { ...valid, metadata: { weight: 23, weight_unit: 'kg', maximum_quantity: 2 } },
      ],
    });

    expect(catalog.baggageServices).toEqual([
      {
        serviceId: 'bag_valid',
        passengerId: 'pas_1',
        segmentIds: ['seg_1'],
        type: 'checked',
        weightValue: 23,
        weightUnit: 'kg',
        maxQuantity: 2,
        amount: '30.00',
        currency: 'USD',
      },
    ]);
  });

  it('defaults optional baggage weight and quantity metadata', () => {
    const catalog = normalizer.normalizeCatalog([], {
      available_services: [
        {
          id: 'bag_default',
          type: 'baggage',
          passenger_ids: ['pas_1'],
          segment_ids: ['seg_1'],
          total_amount: '30.00',
          total_currency: 'USD',
          metadata: { type: 'checked' },
        },
      ],
    });

    expect(catalog.baggageServices).toEqual([
      {
        serviceId: 'bag_default',
        passengerId: 'pas_1',
        segmentIds: ['seg_1'],
        type: 'checked',
        weightValue: null,
        weightUnit: null,
        maxQuantity: 1,
        amount: '30.00',
        currency: 'USD',
      },
    ]);
  });

  it('preserves supplier repricing totals and service-line amounts', () => {
    const result = normalizer.normalizeRepricedOffer(
      {
        total_amount: '473.00',
        base_amount: '420.00',
        total_currency: 'USD',
        service_lines: [
          { service_id: 'seat_1', total_amount: '18.00', quantity: 1 },
          { service_id: 'bag_1', total_amount: '35.00', quantity: 1 },
        ],
      },
      [
        { id: 'seat_1', quantity: 1 },
        { id: 'bag_1', quantity: 1 },
      ],
    );

    expect(result).toEqual({
      totalAmount: '473.00',
      baseAmount: '420.00',
      currency: 'USD',
      serviceLines: [
        { serviceId: 'seat_1', amount: '18.00', quantity: 1 },
        { serviceId: 'bag_1', amount: '35.00', quantity: 1 },
      ],
      invalidServiceIdentities: [],
    });
  });

  it('keeps valid supplier totals when service lines are absent', () => {
    expect(
      normalizer.normalizeRepricedOffer(
        { total_amount: '473.00', base_amount: '420.00', total_currency: 'USD' },
        [{ id: 'seat_1', quantity: 1 }],
      ),
    ).toEqual({
      totalAmount: '473.00',
      baseAmount: '420.00',
      currency: 'USD',
      serviceLines: [],
      invalidServiceIdentities: [],
    });
  });

  it('reports only invalid requested identities from a supplier bad-request response', () => {
    const result = normalizer.normalizeRepricedOffer(
      {
        meta: { status: 400 },
        errors: [{ detail: 'Invalid seat_1' }],
      },
      [
        { id: 'seat_1', quantity: 1 },
        { id: 'bag_1', quantity: 1 },
      ],
    );

    expect(result).toEqual({
      totalAmount: '0.00',
      baseAmount: '0.00',
      currency: 'USD',
      serviceLines: [],
      invalidServiceIdentities: ['seat_1'],
    });
  });

  it('falls back to each submitted identity once when the rejection has no details', () => {
    const result = normalizer.normalizeRepricedOffer(
      { status: 400 },
      [
        { id: 'seat_1', quantity: 1 },
        { id: 'bag_1', quantity: 1 },
        { id: 'seat_1', quantity: 1 },
      ],
    );

    expect(result).toEqual({
      totalAmount: '0.00',
      baseAmount: '0.00',
      currency: 'USD',
      serviceLines: [],
      invalidServiceIdentities: ['seat_1', 'bag_1'],
    });
  });

  it('reads statusCode and deduplicates identities found in error messages', () => {
    const result = normalizer.normalizeRepricedOffer(
      {
        statusCode: 400,
        message: 'Invalid bag_1',
        errors: [
          { message: 'Invalid seat_1' },
          { detail: 'seat_1 remains invalid' },
        ],
      },
      [
        { id: 'seat_1', quantity: 1 },
        { id: 'bag_1', quantity: 1 },
      ],
    );

    expect(result.invalidServiceIdentities).toEqual(['seat_1', 'bag_1']);
  });

  it('rejects malformed supplier money strings without inventing a payable price', () => {
    const malformedOffers: unknown[] = [
      { total_amount: 'invalid', base_amount: '420.00', total_currency: 'USD' },
      { total_amount: '473.00', base_amount: 'invalid', total_currency: 'USD' },
      {
        total_amount: '473.00',
        base_amount: '420.00',
        total_currency: 'USD',
        service_lines: [{ service_id: 'seat_1', total_amount: 'invalid', quantity: 1 }],
      },
    ];

    for (const offer of malformedOffers) {
      expect(() => normalizer.normalizeRepricedOffer(offer, [])).toThrow(
        'Malformed supplier priced offer',
      );
    }
  });

  it('rejects non-finite service quantities in successful supplier pricing', () => {
    expect(() =>
      normalizer.normalizeRepricedOffer(
        {
          total_amount: '473.00',
          base_amount: '420.00',
          total_currency: 'USD',
          service_lines: [{ service_id: 'seat_1', total_amount: '18.00', quantity: Infinity }],
        },
        [{ id: 'seat_1', quantity: 1 }],
      ),
    ).toThrow('Malformed supplier priced offer');
  });

  it('throws a safe error for missing totals or malformed supplier service lines', () => {
    expect(() =>
      normalizer.normalizeRepricedOffer(
        { total_amount: '473.00', total_currency: 'USD' },
        [],
      ),
    ).toThrow('Malformed supplier priced offer');
    expect(() =>
      normalizer.normalizeRepricedOffer(
        {
          total_amount: '473.00',
          base_amount: '420.00',
          total_currency: 'USD',
          service_lines: [{}],
        },
        [],
      ),
    ).toThrow('Malformed supplier priced offer');
  });
});
