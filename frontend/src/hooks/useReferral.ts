import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

const REFERRAL_KEY = 'lazy_ref';
const REFERRAL_EXPIRY_KEY = 'lazy_ref_expiry';
const EXPIRY_DAYS = 30;

/**
 * Hook to capture referral param from URL and store in localStorage
 * Usage: Call once in App.tsx or Layout to auto-capture refs
 */
export function useReferralCapture() {
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const ref = searchParams.get('ref');
    if (ref && ref.length > 0 && ref.length <= 32) {
      // Only store if we don't already have a referral
      const existingRef = localStorage.getItem(REFERRAL_KEY);
      if (!existingRef) {
        localStorage.setItem(REFERRAL_KEY, ref.toLowerCase());
        const expiry = Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000;
        localStorage.setItem(REFERRAL_EXPIRY_KEY, expiry.toString());
      }
    }
  }, [searchParams]);
}

/**
 * Get stored referral handle (or null if none/expired)
 */
export function getReferralHandle(): string | null {
  const ref = localStorage.getItem(REFERRAL_KEY);
  const expiry = localStorage.getItem(REFERRAL_EXPIRY_KEY);

  if (!ref || !expiry) return null;

  if (Date.now() > parseInt(expiry)) {
    // Expired - clean up
    localStorage.removeItem(REFERRAL_KEY);
    localStorage.removeItem(REFERRAL_EXPIRY_KEY);
    return null;
  }

  return ref;
}

/**
 * Clear referral after successful attribution
 */
export function clearReferral() {
  localStorage.removeItem(REFERRAL_KEY);
  localStorage.removeItem(REFERRAL_EXPIRY_KEY);
}

/**
 * Check if there's an active referral
 */
export function hasReferral(): boolean {
  return getReferralHandle() !== null;
}
