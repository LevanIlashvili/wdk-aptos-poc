# wdk-aptos-poc

A terminal wallet (TUI) proof-of-concept built on the published **[@tetherto/wdk](https://www.npmjs.com/package/@tetherto/wdk)** orchestrator + the **[@tetherto/wdk-wallet-aptos](https://github.com/LevanIlashvili/wdk-wallet-aptos)** module. It derives an Aptos account from a BIP-39 seed, reads balances, **mints** a demo fungible asset, **airdrops / sends** it, and broadcasts **real transactions on Aptos testnet** — all through the WDK orchestrator, exercising the wallet module end to end.

Built with [Ink](https://github.com/vadimdemedes/ink) (React for the terminal).

> Testnet only. Do not enter a seed that holds real funds.

## The demo fungible asset (WDKT)

USDT on Aptos is admin-gated (you can't mint it) and uses dispatchable transfer hooks. So this PoC ships its own **plain, openly-mintable** fungible asset — **WDK Demo Token (`WDKT`, 6 decimals)** — published once to testnet from [`move/sources/demo_fa.move`](./move/sources/demo_fa.move).

- Metadata address: `0x8c5afe0cb5cc41754009d41e7977cf169b0ce066be0aac4b4d3badd4339d437e`
- Publisher: `0xb3385f006a92e50cc10ccb122f677d823f9b81afa2ab9473f971511feed310ea`
- `mint` is an **open faucet** (no admin check): any account can mint WDKT to itself, which is what lets the mint / airdrop / send demo run from the user's own wallet.

These are bound as constants in [`src/wallet.js`](./src/wallet.js). To publish your own copy, see [Republishing the FA](#republishing-the-fa).

## What it demonstrates

- **WDK integration**: registers the Aptos wallet against the orchestrator (`new WDK(seed).registerWallet('aptos', WalletManagerAptos, { provider, chainId })`) and drives everything through it.
- **Account + balances dashboard**: address, live APT and WDKT balances, current fee rates.
- **Account switcher**: cycle through derived accounts at index `0, 1, 2, …` (`m/44'/637'/index'/0'/0'`) from the same seed.
- **Mint**: call the demo FA's open-faucet `mint` entry function, signed with the WDK-derived account keypair.
- **Airdrop / send**: transfer WDKT to any address (`0x1::primary_fungible_store::transfer`) — simulated for fee, signed, broadcast, then polled to confirmation. (Airdrop and send are the same on-chain operation.)
- **Send APT**: native transfer (`0x1::aptos_account::transfer`).

## Run

Requires Node >= 20 and an interactive terminal.

```bash
npm install
npm start
```

Both dependencies resolve remotely: `@tetherto/wdk` from the npm registry, and `@tetherto/wdk-wallet-aptos` from GitHub (`github:LevanIlashvili/wdk-wallet-aptos`, pinned to a commit in the lockfile). No sibling checkouts are required — clone and `npm install` anywhere.

## Keys

| Key | Action |
|-----|--------|
| `Ctrl+G` | Generate a fresh seed (on the seed screen) |
| `r` | Refresh balances |
| `n` / `p` | Next / previous account index |
| `m` | Mint 100 WDKT to this account |
| `a` | Send APT |
| `d` | Send / airdrop WDKT to an address |
| `f` | Request 1 APT from the testnet faucet |
| `q` | Quit (disposes the wallet, wiping keys) |

## Funding APT for gas

Every transaction needs a little APT for gas. The Aptos **testnet faucet now requires Google authentication** (a JWT), so the in-app `[f]` faucet call will fail with a message pointing you at the web faucet:

> https://aptos.dev/network/faucet

Fund the displayed address there (sign in with Google), then press `[r]` to refresh. Minting WDKT still requires a small APT balance for gas.

## Republishing the FA

If you want your own demo FA instead of the bundled one:

```bash
cd move
aptos init --network testnet            # creates a publisher key
# fund the publisher address at https://aptos.dev/network/faucet
aptos move publish --named-addresses demo_fa=<publisher-address> --assume-yes
# read the FA metadata address:
aptos move view --function-id <publisher-address>::demo_fa::get_metadata
```

Then update `DEMO_FA_PUBLISHER` and `DEMO_FA_METADATA` in [`src/wallet.js`](./src/wallet.js).

## Notes

- The wallet module talks to the fullnode REST API over `fetch` and uses `sodium-native` for key zeroization, so this runs in **Node** (not a browser). On quit, `wdk.dispose()` zeroes the derived private keys.
- Most chain logic lives in [`src/wallet.js`](./src/wallet.js). Minting calls a custom entry function the shipped wallet module doesn't encode, so [`src/mint.js`](./src/mint.js) builds/signs/submits that one transaction itself (its BCS is byte-verified against the Aptos SDK), using the WDK-derived keypair — the audited module is left untouched.
- The Ink components in [`src/app.js`](./src/app.js) only call into the above.
