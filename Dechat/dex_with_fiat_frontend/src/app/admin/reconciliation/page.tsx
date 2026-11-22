'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReconciliationRecord } from '../../../types';
import AdminGuard from '@/components/AdminGuard';

export interface ReadModelFreshness {
  isStale: boolean;
  sourceLedgerCursor?: string | number | null;
  dbUpdatedAt?: string | null;
}

export default function ReconciliationDashboard() {
  const [records, setRecords] = useState<ReconciliationRecord[]>([]);
  const [filteredRecords, setFilteredRecords] = useState<
    ReconciliationRecord[]
  >([]);
  const [totals, setTotals] = useState<ReconciliationTotals | undefined>();
  const [verifiedTotals, setVerifiedTotals] = useState<
    ReconciliationTotals | undefined
  >();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [reviewOnly, setReviewOnly] = useState<boolean>(false);
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [showReauthPrompt, setShowReauthPrompt] = useState(false);
  const [freshness, setFreshness] = useState<ReadModelFreshness | null>(null);

  useEffect(() => {
    fetchReconciliationData();
  }, []);

  const fetchReconciliationData = async () => {
    try {
      const response = await fetch('/api/admin/reconciliation', {
        credentials: 'include',
      });
      
      if (response.status === 401) {
        setShowReauthPrompt(true);
        setLoading(false);
        return;
      }
      
      if (response.ok) {
        const data = await response.json();
        // Support both the legacy bare-array payload and the freshness-aware
        // envelope { records, isStale, sourceLedgerCursor, dbUpdatedAt }.
        if (Array.isArray(data)) {
          setRecords(data);
          setFreshness(null);
        } else {
          setRecords(data.records ?? []);
          setFreshness({
            isStale: Boolean(data.isStale),
            sourceLedgerCursor: data.sourceLedgerCursor ?? null,
            dbUpdatedAt: data.dbUpdatedAt ?? null,
          });
        }
      } else {
        console.error('Failed to fetch data');
      }

      const conflictResponse = await fetch(
        '/api/admin/reconciliation?format=conflicts',
        { credentials: 'include' },
      );
      if (conflictResponse.ok) {
        const conflictData = await conflictResponse.json();
        setConflictCount(
          Array.isArray(conflictData.conflicts)
            ? conflictData.conflicts.length
            : 0,
        );
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  const filterRecords = useCallback(() => {
    let filtered = records;

    if (statusFilter !== 'all') {
      filtered = filtered.filter((record) => record.status === statusFilter);
    }

    if (reviewOnly) {
      filtered = filtered.filter((record) => isReviewState(record.status));
    }

    if (startDate) {
      filtered = filtered.filter(
        (record) => new Date(record.depositDate) >= new Date(startDate),
      );
    }

    if (endDate) {
      filtered = filtered.filter(
        (record) => new Date(record.depositDate) <= new Date(endDate),
      );
    }

    setFilteredRecords(filtered);
  }, [records, statusFilter, reviewOnly, startDate, endDate]);

  useEffect(() => {
    filterRecords();
  }, [filterRecords]);

  const exportToCSV = () => {
    const headers = [
      'ID',
      'Deposit TX Hash',
      'Deposit Amount',
      'Deposit User',
      'Deposit Date',
      'Payout ID',
      'Payout Amount',
      'Payout Recipient',
      'Payout Status',
      'Payout Date',
      'Status',
      'Age (hours)',
      'Amount At Risk',
      'Next Action',
      'Source Evidence',
      'Runbook URL',
    ];

    const csvContent = [
      headers.join(','),
      ...filteredRecords.map((record) =>
        [
          record.id,
          record.depositTxHash,
          record.depositAmount,
          record.depositUser,
          record.depositDate,
          record.payoutId,
          record.payoutAmount,
          record.payoutRecipient,
          record.payoutStatus,
          record.payoutDate,
          record.status,
          getAgeInHours(record.depositDate).toFixed(2),
          record.status === 'matched' ? 0 : record.depositAmount,
          `"${getNextAction(record)}"`,
          `"${record.sourceEvidence ?? record.depositTxHash}"`,
          getRunbookUrl(record.status),
        ].join(','),
      ),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute(
      'download',
      `reconciliation_${new Date().toISOString().split('T')[0]}.csv`,
    );
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (loading) {
    return (
      <AdminGuard>
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-8">
          <div className="max-w-7xl mx-auto">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-8">
              Admin Reconciliation Dashboard
            </h1>
            <div className="text-center">Loading...</div>
          </div>
        </div>
      </AdminGuard>
    );
  }

  return (
    <AdminGuard>
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-8">
          Admin Reconciliation Dashboard
        </h1>
        {conflictCount > 0 && (
          <div
            role="status"
            className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
          >
            {conflictCount} payout evidence conflict
            {conflictCount === 1 ? '' : 's'} require operator review. Conflicting
            evidence is preserved and was not silently overwritten.
          </div>
        )}

        {totalsMismatch(totals, verifiedTotals) && (
          <div
            role="alert"
            className="mb-8 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-700 dark:bg-red-900/40 dark:text-red-200"
          >
            <p className="font-semibold">
              Displayed totals do not match database-verified totals.
            </p>
            <p className="mt-1">
              Displayed: {totals?.unresolvedCount ?? 0} unresolved /{' '}
              {totals?.amountAtRisk ?? 0} {totals?.currency ?? 'XLM'} at risk.
              Verified: {verifiedTotals?.unresolvedCount ?? 0} unresolved /{' '}
              {verifiedTotals?.amountAtRisk ?? 0}{' '}
              {verifiedTotals?.currency ?? 'XLM'} at risk.
            </p>
            <a
              href={`${RUNBOOK_BASE_URL}#totals-mismatch`}
              className="mt-2 inline-block font-medium underline"
            >
              Follow the totals mismatch runbook
            </a>
          </div>
        )}

        {/* SLO Summary */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
              Unresolved Payouts
            </div>
            <div className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
              {totals?.unresolvedCount ?? 0}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
              Amount At Risk
            </div>
            <div className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
              {totals?.amountAtRisk ?? 0} {totals?.currency ?? 'XLM'}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
              DB-Verified Amount At Risk
            </div>
            <div className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
              {verifiedTotals?.amountAtRisk ?? 0}{' '}
              {verifiedTotals?.currency ?? 'XLM'}
            </div>
          </div>
        </div>

        {/* Read-model freshness metadata */}
        {freshness && (
          <div
            data-testid="reconciliation-freshness"
            className="mb-8 flex flex-wrap items-center gap-4 text-sm text-gray-600 dark:text-gray-400"
          >
            {freshness.isStale ? (
              <span
                data-testid="reconciliation-stale-badge"
                className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200"
              >
                Stale projection — not confirmed settlement state
              </span>
            ) : (
              <span
                data-testid="reconciliation-fresh-badge"
                className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200"
              >
                Fresh
              </span>
            )}
            {freshness.sourceLedgerCursor !== null &&
              freshness.sourceLedgerCursor !== undefined && (
                <span data-testid="reconciliation-ledger-cursor">
                  Ledger cursor: {String(freshness.sourceLedgerCursor)}
                </span>
              )}
            {freshness.dbUpdatedAt && (
              <span data-testid="reconciliation-db-updated-at">
                DB updated: {new Date(freshness.dbUpdatedAt).toLocaleString()}
              </span>
            )}
          </div>
        )}

        {/* Filters */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label
                htmlFor="reconciliation-status-filter"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
              >
                Status
              </label>
              <select
                id="reconciliation-status-filter"
                aria-label="Status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="reconciliation-start-date"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
              >
                Start Date
              </label>
              <input
                id="reconciliation-start-date"
                type="date"
                aria-label="Start Date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
              />
            </div>
            <div>
              <label
                htmlFor="reconciliation-end-date"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
              >
                End Date
              </label>
              <input
                id="reconciliation-end-date"
                type="date"
                aria-label="End Date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
              />
            </div>
            <div className="flex items-end">
              <button
                onClick={exportToCSV}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Export CSV
              </button>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <input
              id="reconciliation-review-only"
              type="checkbox"
              checked={reviewOnly}
              onChange={(e) => setReviewOnly(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <label
              htmlFor="reconciliation-review-only"
              className="text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Show review queue only (ambiguous &amp; conflict)
            </label>
          </div>
        </div>

        {/* Review queue notice */}
        <div className="bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-700 rounded-lg p-4 mb-8">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            Records with an <strong>ambiguous</strong> or <strong>conflict</strong>{' '}
            confidence state are held for manual review and are not
            auto-settled. Verify the contract event, internal payout record, and
            provider evidence before taking action.
          </p>
        </div>

        {/* Table */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-700">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Deposit
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Payout
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Age
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Amount At Risk
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Next Action
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Source Evidence
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {filteredRecords.map((record) => (
                  <tr
                    key={record.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900 dark:text-white">
                        <div className="font-medium">
                          {record.depositAmount} XLM
                        </div>
                        <div className="text-gray-500 dark:text-gray-400">
                          {record.depositTxHash.slice(0, 10)}...
                        </div>
                        <div className="text-gray-500 dark:text-gray-400">
                          {new Date(record.depositDate).toLocaleDateString()}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900 dark:text-white">
                        {record.payoutId ? (
                          <>
                            <div className="font-medium">
                              {record.payoutAmount}{' '}
                              {record.payoutStatus === 'completed' ? 'NGN' : ''}
                            </div>
                            <div className="text-gray-500 dark:text-gray-400">
                              {record.payoutId}
                            </div>
                            <div className="text-gray-500 dark:text-gray-400">
                              {record.payoutRecipient}
                            </div>
                          </>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-500">
                            No payout
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {freshness?.isStale ? (
                        <span
                          data-testid="reconciliation-record-stale"
                          className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200"
                        >
                          Stale — unconfirmed
                        </span>
                      ) : (
                        <>
                          <span
                            className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                              record.status === 'matched'
                                ? 'bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200'
                                : record.status === 'unmatched'
                                  ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200'
                                  : 'bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200'
                            }`}
                          >
                            {record.status}
                          </span>
                          {record.payoutId && (
                            <div className="mt-1">
                              <span
                                className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                  record.payoutStatus === 'completed'
                                    ? 'bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200'
                                    : record.payoutStatus === 'pending'
                                      ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200'
                                      : 'bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200'
                                }`}
                              >
                                {record.payoutStatus}
                              </span>
                            </div>
                          )}
                        </>
                      )}
                      {record.status !== 'matched' && (
                        <div className="mt-1">
                          <a
                            href={getRunbookUrl(record.status)}
                            className="text-xs font-medium text-blue-600 underline dark:text-blue-400"
                          >
                            Runbook
                          </a>
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-white">
                      {formatAge(getAgeInHours(record.depositDate))}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-white">
                      {record.status === 'matched' ? 0 : record.depositAmount}{' '}
                      XLM
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                      {getNextAction(record)}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
                      <div className="font-mono break-all">
                        {record.sourceEvidence ?? record.depositTxHash}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {isReviewState(record.status) ? (
                        <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200">
                          Manual review required
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          —
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filteredRecords.length === 0 && (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              No records found matching the filters.
            </div>
          )}
        </div>
      </div>

      {showReauthPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-md mx-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
              Session Expired
            </h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              Your admin session has expired. Please refresh the page to re-authenticate.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="w-full py-2 rounded-md font-medium bg-blue-600 text-white hover:bg-blue-700"
            >
              Refresh Page
            </button>
          </div>
        </div>
      )}
      </div>
    </AdminGuard>
  );
}
