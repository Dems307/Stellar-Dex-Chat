'use client';

import { useTranslation } from '@/contexts/TranslationContext';

/**
 * useRtlDirection
 *
 * Convenience hook that surfaces the writing-direction values from the active
 * locale.  Components that need to conditionally flip icons or swap logical
 * CSS classes import this hook instead of reaching into TranslationContext
 * directly.
 *
 * @returns {{ isRtl: boolean, dir: 'ltr' | 'rtl' }}
 *
 * @example
 * const { isRtl, dir } = useRtlDirection();
 * // Flip a directional chevron icon in RTL:
 * <ChevronRight className={isRtl ? 'scale-x-[-1]' : ''} />
 */
export function useRtlDirection(): { isRtl: boolean; dir: 'ltr' | 'rtl' } {
  const { isRtl, dir } = useTranslation();
  return { isRtl, dir };
}
