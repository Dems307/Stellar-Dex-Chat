import { describe, expect, it } from 'vitest';
import {
  estimateSettlementWindow,
  type ProviderSettlementCalendar,
} from './settlementCalendar';

const calendar: ProviderSettlementCalendar = {
  provider: 'paystack',
  currency: 'NGN',
  timeZone: 'Africa/Lagos',
  cutoffLocalTime: '14:00',
  businessDays: [1, 2, 3, 4, 5],
  nonProcessingDates: ['2026-11-23'],
  earliestBusinessDays: 0,
  latestBusinessDays: 1,
  settlementWindowStart: '09:00',
  settlementWindowEnd: '17:00',
  source: 'test-calendar',
};

describe('estimateSettlementWindow', () => {
  it('returns a configured timezone and source and observes cutoff and holidays', () => {
    const estimate = estimateSettlementWindow(
      calendar,
      new Date('2026-11-20T14:30:00.000Z'),
    );

    expect(estimate).toEqual({
      provider: 'paystack',
      currency: 'NGN',
      earliestAt: '2026-11-24T08:00:00.000Z',
      latestAt: '2026-11-25T16:00:00.000Z',
      timeZone: 'Africa/Lagos',
      source: 'test-calendar',
    });
  });

  it('uses the same processing day before cutoff and skips non-business days', () => {
    const estimate = estimateSettlementWindow(
      calendar,
      new Date('2026-11-20T08:00:00.000Z'),
    );

    expect(estimate.earliestAt).toBe('2026-11-20T08:00:00.000Z');
    expect(estimate.latestAt).toBe('2026-11-24T16:00:00.000Z');
  });

  it('rejects invalid date input and invalid schedule ranges', () => {
    expect(() =>
      estimateSettlementWindow(calendar, new Date('invalid')),
    ).toThrow(/valid date/i);
    expect(() =>
      estimateSettlementWindow(
        { ...calendar, earliestBusinessDays: 2, latestBusinessDays: 1 },
        new Date('2026-11-20T08:00:00.000Z'),
      ),
    ).toThrow(/range is invalid/i);
  });
});
