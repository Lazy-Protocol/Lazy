type DepositSnapshot = {
  chainId: number;
  vault: string;
  cutoffBlock: number;
  cutoffBlockHash: string;
  cutoffTimestamp: string;
  capturedAt: string;
  depositCount: number;
  totalDeposited: string;
  depositors: string[];
};

export type DepositAccess = 'disconnected' | 'allowed' | 'invitation-required' | 'unavailable';

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value);
}

function isAddressList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isAddress);
}

function isSnapshot(value: unknown, vault: string, chainId: number): value is DepositSnapshot {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<DepositSnapshot>;
  return data.chainId === chainId && isAddress(data.vault) && data.vault.toLowerCase() === vault.toLowerCase() &&
    typeof data.cutoffBlock === 'number' && Number.isSafeInteger(data.cutoffBlock) && data.cutoffBlock > 0 &&
    typeof data.cutoffBlockHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(data.cutoffBlockHash) &&
    typeof data.cutoffTimestamp === 'string' && Number.isFinite(Date.parse(data.cutoffTimestamp)) &&
    typeof data.capturedAt === 'string' && Number.isFinite(Date.parse(data.capturedAt)) &&
    typeof data.depositCount === 'number' && Number.isSafeInteger(data.depositCount) &&
    typeof data.totalDeposited === 'string' && /^[1-9][0-9]*$/.test(data.totalDeposited) &&
    isAddressList(data.depositors) && data.depositors.length > 0 && data.depositCount >= data.depositors.length &&
    new Set(data.depositors.map(address => address.toLowerCase())).size === data.depositors.length;
}

// This is a website policy. It cannot stop direct interaction with the public contract.
// Eligibility comes from the frozen deposit history or explicit invitations, never
// from today's share balance or deposits made after the grandfathering cutoff.
export function createDepositPolicy(snapshot: unknown, invited: unknown, vault: string, chainId: number) {
  const valid = isSnapshot(snapshot, vault, chainId) && isAddressList(invited);
  const approved = valid
    ? new Set([...snapshot.depositors, ...invited].map(address => address.toLowerCase()))
    : new Set<string>();

  function access(address: string | undefined): DepositAccess {
    if (!address) return 'disconnected';
    if (!valid) return 'unavailable';
    return isAddress(address) && approved.has(address.toLowerCase()) ? 'allowed' : 'invitation-required';
  }

  return { valid, access };
}
