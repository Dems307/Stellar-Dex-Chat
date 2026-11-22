export interface ProviderSettlementCalendar {
  provider: string;
  currency: string;
  timeZone: string;
  cutoffLocalTime: string;
  businessDays: readonly number[];
  nonProcessingDates: readonly string[];
  earliestBusinessDays: number;
  latestBusinessDays: number;
  settlementWindowStart: string;
  settlementWindowEnd: string;
  source: string;
}

export interface SettlementEstimate {
  provider: string;
  currency: string;
  earliestAt: string;
  latestAt: string;
  timeZone: string;
  source: string;
}

export const PAYSTACK_SETTLEMENT_CALENDARS: Record<
  string,
  ProviderSettlementCalendar
> = {
  NGN: {
    provider: 'paystack',
    currency: 'NGN',
    timeZone: 'Africa/Lagos',
    cutoffLocalTime: '14:00',
    businessDays: [1, 2, 3, 4, 5],
    nonProcessingDates: [],
    earliestBusinessDays: 0,
    latestBusinessDays: 1,
    settlementWindowStart: '09:00',
    settlementWindowEnd: '17:00',
    source: 'provider-config:paystack:NGN',
  },
};

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function localDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = targetAsUtc;

  for (let attempt = 0; attempt < 4; attempt++) {
    const observed = getZonedParts(new Date(timestamp), timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
    );
    const difference = targetAsUtc - observedAsUtc;
    timestamp += difference;
    if (difference === 0) break;
  }

  return new Date(timestamp);
}

function parseLocalTime(value: string): [number, number] {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid local time: ${value}`);
  }
  return [Number(match[1]), Number(match[2])];
}

function isBusinessDay(
  year: number,
  month: number,
  day: number,
  calendar: ProviderSettlementCalendar,
): boolean {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dateKey = `${year.toString().padStart(4, '0')}-${month
    .toString()
    .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  return (
    calendar.businessDays.includes(weekday) &&
    !calendar.nonProcessingDates.includes(dateKey)
  );
}

function nextBusinessDate(
  date: Pick<ZonedParts, 'year' | 'month' | 'day'>,
  calendar: ProviderSettlementCalendar,
): Pick<ZonedParts, 'year' | 'month' | 'day'> {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  while (
    !isBusinessDay(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      calendar,
    )
  ) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function addBusinessDays(
  date: Pick<ZonedParts, 'year' | 'month' | 'day'>,
  days: number,
  calendar: ProviderSettlementCalendar,
): Pick<ZonedParts, 'year' | 'month' | 'day'> {
  let result = date;
  for (let remaining = days; remaining > 0; remaining--) {
    result = nextBusinessDate(result, calendar);
  }
  return result;
}

export function estimateSettlementWindow(
  calendar: ProviderSettlementCalendar,
  initiatedAt: Date = new Date(),
): SettlementEstimate {
  if (!Number.isFinite(initiatedAt.getTime())) {
    throw new Error('Initiation time must be a valid date');
  }
  if (
    !Number.isInteger(calendar.earliestBusinessDays) ||
    !Number.isInteger(calendar.latestBusinessDays) ||
    calendar.earliestBusinessDays < 0 ||
    calendar.latestBusinessDays < calendar.earliestBusinessDays
  ) {
    throw new Error('Settlement business-day range is invalid');
  }

  const [cutoffHour, cutoffMinute] = parseLocalTime(calendar.cutoffLocalTime);
  const [windowStartHour, windowStartMinute] = parseLocalTime(
    calendar.settlementWindowStart,
  );
  const [windowEndHour, windowEndMinute] = parseLocalTime(
    calendar.settlementWindowEnd,
  );
  const localStart = getZonedParts(initiatedAt, calendar.timeZone);

  let processingDate: Pick<ZonedParts, 'year' | 'month' | 'day'> = localStart;
  if (
    !isBusinessDay(
      localStart.year,
      localStart.month,
      localStart.day,
      calendar,
    ) ||
    localStart.hour * 60 + localStart.minute >= cutoffHour * 60 + cutoffMinute
  ) {
    processingDate = nextBusinessDate(localStart, calendar);
  }

  const earliestDate = addBusinessDays(
    processingDate,
    calendar.earliestBusinessDays,
    calendar,
  );
  const latestDate = addBusinessDays(
    processingDate,
    calendar.latestBusinessDays,
    calendar,
  );

  return {
    provider: calendar.provider,
    currency: calendar.currency,
    earliestAt: localDateTimeToUtc(
      earliestDate.year,
      earliestDate.month,
      earliestDate.day,
      windowStartHour,
      windowStartMinute,
      calendar.timeZone,
    ).toISOString(),
    latestAt: localDateTimeToUtc(
      latestDate.year,
      latestDate.month,
      latestDate.day,
      windowEndHour,
      windowEndMinute,
      calendar.timeZone,
    ).toISOString(),
    timeZone: calendar.timeZone,
    source: calendar.source,
  };
}
