# React + TypeScript + Vite

## Deposit access

The website allows deposits only from wallets in either of these files:

- `src/config/grandfathered-depositors.json`: the fixed list of existing and past depositors, captured from mainnet Deposit events and reconciled against the vault's cumulative deposits at the recorded block.
- `src/config/invited-depositors.json`: a JSON array of additional Ethereum wallet addresses. Add a new invitation here, then run `npm test`, `npm run lint`, and `npm run build` before deploying the frontend through the normal release process.

Fully withdrawn depositors keep access. Holding transferred shares does not grant deposit access. Deposits made directly through the contract after the recorded cutoff do not automatically add a wallet to the website's access list.

Keep the original grandfathered snapshot. Do not refresh it as part of stats updates or routine deployment. The one-time capture script, `node scripts/snapshot-depositors.mjs` from the repository root, refuses to overwrite it. New invitations belong in the separate invitation list.

Before rollout, run `node scripts/snapshot-depositors.mjs --verify` from the repository root. It checks the recorded block and cumulative deposits, and reports whether any deposits occurred after the cutoff so those wallets can be reviewed for invitations. It does not change the saved list. The script uses the existing root `ETH_RPC_URL`; the initial capture also needs `ETHERSCAN_API_KEY`. Credentials are never included in the frontend.

The deposit dialog and both approval/deposit write hooks check the same policy. Invalid configuration fails the build. Public information, portfolio access, and withdrawals do not require deposit eligibility.

This restricts the official frontend only. The deployed public contract remains callable directly. The wallet list is public build configuration, not a secret or a server-side authorization boundary.

---

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
