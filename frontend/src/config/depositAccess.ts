import grandfathered from './grandfathered-depositors.json';
import invited from './invited-depositors.json';
import { CONTRACTS, VAULT_CHAIN_ID } from './contracts';
import { createDepositPolicy } from '../lib/depositPolicy';

const policy = createDepositPolicy(grandfathered, invited, CONTRACTS.vault, VAULT_CHAIN_ID);

export const getDepositAccess = policy.access;

export function assertDepositAccess(address: string) {
  if (getDepositAccess(address) !== 'allowed') {
    throw new Error('Deposit access is required for this wallet.');
  }
}
