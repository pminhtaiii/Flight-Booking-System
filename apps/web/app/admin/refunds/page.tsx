/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';

export default function AdminRefundsPage() {
  const { data: session, status } = useSession();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [refunds, setRefunds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  useEffect(() => {
    async function checkRole() {
      const currentSession = session as any;
      if (status === 'authenticated' && currentSession?.accessToken) {
        try {
          const res = await fetch('/api/auth/me', {
            headers: {
              Authorization: `Bearer ${currentSession.accessToken}`,
            },
          });
          if (res.ok) {
            const data = await res.json();
            setIsAdmin(data.role === 'ADMIN');
          } else {
            setIsAdmin(false);
          }
        } catch (err) {
          setIsAdmin(false);
        }
      } else if (status === 'unauthenticated') {
        setIsAdmin(false);
      }
    }
    checkRole();
  }, [session, status]);

  const fetchRefunds = async () => {
    const currentSession = session as any;
    if (!currentSession?.accessToken) return;
    setLoading(true);
    try {
      const res = await fetch('/api/admin/refunds', {
        headers: {
          Authorization: `Bearer ${currentSession.accessToken}`,
        },
      });
      if (!res.ok) throw new Error('Failed to fetch refunds');
      const data = await res.json();
      setRefunds(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      fetchRefunds();
    } else {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, session]);

  const handleResolve = async (refundId: string, action: 'RETRY_WITH_FRESH_KEY' | 'MARK_RESOLVED_MANUALLY') => {
    const currentSession = session as any;
    if (!currentSession?.accessToken) return;
    setActionLoading(refundId);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/refunds/${refundId}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentSession.accessToken}`,
        },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || 'Action failed');
      }
      setMessage({ type: 'success', text: `Successfully resolved refund ${refundId} via ${action}` });
      fetchRefunds();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setActionLoading(null);
    }
  };

  if (status === 'loading' || isAdmin === null || (isAdmin && loading && refunds.length === 0)) {
    return <div className="p-8 text-center text-text-secondary">Loading...</div>;
  }

  if (!isAdmin) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="bg-bg-cancelled border border-danger-border p-6 rounded-lg text-center">
          <h1 className="text-xl font-bold text-text-cancelled mb-2">Access Denied</h1>
          <p className="text-text-secondary">You do not have permission to view this page.</p>
        </div>
      </div>
    );
  }

  const currencyFormatter = (amount: number, currency: string) =>
    new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount / 100);

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Escalated Refunds Management</h1>
        <p className="text-text-secondary mt-1">Review and resolve refunds that require manual attention.</p>
      </div>

      {message && (
        <div className={`p-4 rounded-lg border ${message.type === 'success' ? 'bg-bg-confirmed border-success-border text-text-confirmed' : 'bg-bg-cancelled border-danger-border text-text-cancelled'}`}>
          {message.text}
        </div>
      )}

      {error && (
        <div className="p-4 bg-bg-cancelled border border-danger-border rounded-lg text-text-cancelled">
          {error}
        </div>
      )}

      <div className="bg-bg-secondary rounded-xl border border-border-primary overflow-hidden">
        {refunds.length === 0 ? (
          <div className="p-8 text-center text-text-secondary">
            No escalated refunds require attention right now.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-background border-b border-border-primary text-text-secondary">
                <tr>
                  <th className="px-6 py-4 font-medium">Refund / Booking</th>
                  <th className="px-6 py-4 font-medium">Amount</th>
                  <th className="px-6 py-4 font-medium">Diagnostic Info</th>
                  <th className="px-6 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-primary">
                {refunds.map((refund) => (
                  <tr key={refund.id} className="hover:bg-background/50 transition-colors">
                    <td className="px-6 py-4 align-top">
                      <div className="font-mono text-xs text-text-primary truncate w-32" title={refund.id}>{refund.id}</div>
                      <div className="mt-1 text-text-secondary">Booking: <span className="font-mono text-xs">{refund.bookingId}</span></div>
                      {refund.booking?.pnrReference && (
                        <div className="mt-1 text-text-secondary">PNR: <span className="font-semibold">{refund.booking.pnrReference}</span></div>
                      )}
                    </td>
                    <td className="px-6 py-4 align-top">
                      <div className="font-medium text-text-primary">{currencyFormatter(refund.amount, refund.currency)}</div>
                      <div className="mt-1 text-xs text-text-secondary">Total Paid: {refund.payment ? currencyFormatter(refund.payment.amount, refund.payment.currency) : 'N/A'}</div>
                    </td>
                    <td className="px-6 py-4 align-top">
                      <div className="space-y-1 text-xs">
                        <p><span className="text-text-secondary">Retries:</span> <span className="text-text-primary">{refund.retryCount}</span></p>
                        {refund.nextRetryAt && <p><span className="text-text-secondary">Next Retry:</span> <span className="text-text-primary">{new Date(refund.nextRetryAt).toLocaleString()}</span></p>}
                        {refund.lastErrorCode && <p><span className="text-text-secondary">Last Error:</span> <span className="text-text-cancelled font-semibold">{refund.lastErrorCode}</span></p>}
                      </div>
                    </td>
                    <td className="px-6 py-4 align-top text-right">
                      <div className="flex flex-col gap-2 items-end">
                        <button
                          onClick={() => handleResolve(refund.id, 'RETRY_WITH_FRESH_KEY')}
                          disabled={actionLoading === refund.id}
                          className="px-3 py-1.5 bg-bg-pending text-text-pending border border-warning-border rounded hover:bg-bg-pending/80 transition-colors disabled:opacity-50 text-xs w-full max-w-[200px]"
                        >
                          {actionLoading === refund.id ? 'Processing...' : 'Retry with Fresh Key'}
                        </button>
                        <button
                          onClick={() => handleResolve(refund.id, 'MARK_RESOLVED_MANUALLY')}
                          disabled={actionLoading === refund.id}
                          className="px-3 py-1.5 bg-background text-text-primary border border-border-primary rounded hover:bg-border-primary transition-colors disabled:opacity-50 text-xs w-full max-w-[200px]"
                        >
                          {actionLoading === refund.id ? 'Processing...' : 'Mark Resolved Manually'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
