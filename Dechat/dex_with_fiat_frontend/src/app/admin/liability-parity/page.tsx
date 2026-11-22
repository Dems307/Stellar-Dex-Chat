'use client';

import { useCallback, useEffect, useState } from 'react';
import AdminGuard from '@/components/AdminGuard';
import type { LiabilityParityReport } from '@/lib/payout/liabilityParity';

const RUNBOOK_URL = '/docs/runbooks/liability-parity';

function formatMinor(amountMinor: string): string {
  try {
    return BigInt(amountMinor).toLocaleString('en-US');
  } catch {
    return amountMinor;
  }
}

export default function LiabilityParityPage() {
  const [report, setReport] = useState<LiabilityParityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/liability-parity', {
        credentials: 'include',
      });
      if (response.status === 401) {
        setSessionExpired(true);
        setReport(null);
        return;
      }
      if (!response.ok) {
        throw new Error(`Parity check failed with status ${response.status}`);
      }
      setSessionExpired(false);
      setReport((await response.json()) as LiabilityParityReport);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Parity check failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  return (
    <AdminGuard>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-8">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
                Escrow Liability Parity
              </h1>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                Compare on-chain escrow receipts with persisted payout reservations.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadReport()}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              Run check
            </button>
          </div>

          <div
            role="status"
            className="mb-6 rounded-lg border border-blue-300 bg-blue-50 px-4 py-3 text-blue-900 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-100"
          >
            Read-only check. No payout, reservation, or contract state is changed.
          </div>

          {sessionExpired && (
            <div
              role="alert"
              className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
            >
              Your admin session expired. Refresh the page to re-authenticate.
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 text-red-800 dark:border-red-700 dark:bg-red-900/40 dark:text-red-200"
            >
              {error}
            </div>
          )}

          {loading && (
            <div className="rounded-lg bg-white p-8 text-center text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              Checking parity...
            </div>
          )}

          {!loading && report && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                <div className="rounded-lg bg-white p-6 shadow dark:bg-gray-800">
                  <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
                    Result
                  </div>
                  <div className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                    {report.ok ? 'In parity' : 'Mismatch found'}
                  </div>
                </div>
                <div className="rounded-lg bg-white p-6 shadow dark:bg-gray-800">
                  <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
                    Receipts checked
                  </div>
                  <div className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                    {report.totals.receipts}
                  </div>
                </div>
                <div className="rounded-lg bg-white p-6 shadow dark:bg-gray-800">
                  <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
                    Mismatched receipts
                  </div>
                  <div className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                    {report.totals.mismatchedReceipts}
                  </div>
                </div>
                <div className="rounded-lg bg-white p-6 shadow dark:bg-gray-800">
                  <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
                    Invalid records
                  </div>
                  <div className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                    {report.totals.invalidRecords}
                  </div>
                </div>
              </div>

              <section className="mb-8 rounded-lg bg-white shadow dark:bg-gray-800">
                <h2 className="border-b border-gray-200 px-6 py-4 text-lg font-semibold text-gray-900 dark:border-gray-700 dark:text-white">
                  Totals by asset
                </h2>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-700">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300">
                          Asset
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300">
                          On-chain minor units
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300">
                          Reserved minor units
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300">
                          Delta
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {report.byAsset.map((asset) => (
                        <tr key={asset.asset}>
                          <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                            {asset.asset}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                            {formatMinor(asset.onChainMinor)}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                            {formatMinor(asset.reservedMinor)}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                            {asset.deltaMinor}
                          </td>
                        </tr>
                      ))}
                      {report.byAsset.length === 0 && (
                        <tr>
                          <td
                            colSpan={4}
                            className="px-6 py-8 text-center text-sm text-gray-500 dark:text-gray-400"
                          >
                            No active liabilities or reservations found.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="rounded-lg bg-white shadow dark:bg-gray-800">
                <h2 className="border-b border-gray-200 px-6 py-4 text-lg font-semibold text-gray-900 dark:border-gray-700 dark:text-white">
                  Mismatches by asset and receipt
                </h2>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-700">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300">
                          Asset
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300">
                          Receipt
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300">
                          Payouts
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300">
                          On-chain / reserved
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300">
                          Delta
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-300">
                          Reason
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {report.mismatches.map((mismatch, index) => (
                        <tr key={`${mismatch.key}-${mismatch.type}-${index}`}>
                          <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                            {mismatch.asset}
                          </td>
                          <td className="px-6 py-4 font-mono text-xs text-gray-700 dark:text-gray-300">
                            {mismatch.receiptId}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">
                            {mismatch.payoutIds.join(', ') || '—'}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                            {formatMinor(mismatch.onChainMinor)} /{' '}
                            {formatMinor(mismatch.reservedMinor)}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                            {mismatch.deltaMinor}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">
                            {mismatch.type}: {mismatch.reason}
                          </td>
                        </tr>
                      ))}
                      {report.mismatches.length === 0 && (
                        <tr>
                          <td
                            colSpan={6}
                            className="px-6 py-8 text-center text-sm text-gray-500 dark:text-gray-400"
                          >
                            No mismatches found.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <p className="mt-6 text-sm text-gray-600 dark:text-gray-400">
                See the{' '}
                <a href={RUNBOOK_URL} className="font-medium underline">
                  liability parity runbook
                </a>{' '}
                for investigation steps.
              </p>
            </>
          )}
        </div>
      </div>
    </AdminGuard>
  );
}
