import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import grandfathered from './src/config/grandfathered-depositors.json'
import invited from './src/config/invited-depositors.json'
import { CONTRACTS, VAULT_CHAIN_ID } from './src/config/contracts'
import { createDepositPolicy } from './src/lib/depositPolicy'

if (!createDepositPolicy(grandfathered, invited, CONTRACTS.vault, VAULT_CHAIN_ID).valid) {
  throw new Error('Invalid deposit access configuration. Check the depositor snapshot and invitation list.')
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
