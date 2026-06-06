// WDK + Aptos wallet logic for the PoC. Keeps all chain/RPC concerns out of the
// React (Ink) components — the UI only calls these functions.

'use strict'

import WDK from '@tetherto/wdk'
import WalletManagerAptos from '@tetherto/wdk-wallet-aptos'

import { mintFa } from './mint.js'

export const APTOS_TESTNET = 'https://fullnode.testnet.aptoslabs.com/v1'
export const APTOS_FAUCET = 'https://faucet.testnet.aptoslabs.com'
export const TESTNET_CHAIN_ID = 2

// WDK Demo Token (WDKT) — a plain, openly-mintable fungible asset published for
// this PoC on Aptos testnet (move/sources/demo_fa.move). 6 decimals, mirroring
// USDT. The metadata address is derived deterministically from the publisher
// address and the "WDKT" object seed; the open-faucet `mint` lets any account
// self-fund test tokens.
export const DEMO_FA_PUBLISHER = '0xb3385f006a92e50cc10ccb122f677d823f9b81afa2ab9473f971511feed310ea'
export const DEMO_FA_METADATA = '0x8c5afe0cb5cc41754009d41e7977cf169b0ce066be0aac4b4d3badd4339d437e'
export const DEMO_FA_SYMBOL = 'WDKT'
export const DEMO_FA_DECIMALS = 6

export const APT_DECIMALS = 8

const BLOCKCHAIN = 'aptos'

/**
 * Creates a WDK instance with the Aptos wallet registered against testnet.
 *
 * @param {string} seedPhrase - The BIP-39 seed phrase.
 * @returns {import('@tetherto/wdk').default} The WDK instance.
 */
export function createWallet (seedPhrase) {
  return new WDK(seedPhrase).registerWallet(BLOCKCHAIN, WalletManagerAptos, {
    provider: APTOS_TESTNET,
    chainId: TESTNET_CHAIN_ID
  })
}

/**
 * Generates a fresh random 12-word seed phrase.
 *
 * @returns {string} The seed phrase.
 */
export function generateSeed () {
  return WDK.getRandomSeedPhrase()
}

/**
 * Validates a seed phrase.
 *
 * @param {string} seedPhrase - The seed phrase.
 * @returns {boolean} True if valid.
 */
export function isValidSeed (seedPhrase) {
  return WDK.isValidSeed(seedPhrase.trim())
}

/**
 * Loads an account at the given index and reads its address and balances.
 *
 * @param {import('@tetherto/wdk').default} wdk - The WDK instance.
 * @param {number} index - The account index.
 * @returns {Promise<{ account: object, address: string, apt: bigint, token: bigint }>} The snapshot.
 */
export async function loadAccount (wdk, index) {
  const account = await wdk.getAccount(BLOCKCHAIN, index)
  const address = await account.getAddress()

  const [apt, token] = await Promise.all([
    account.getBalance(),
    account.getTokenBalance(DEMO_FA_METADATA)
  ])

  return { account, address, apt, token }
}

/**
 * Reads the current testnet fee rates.
 *
 * @param {import('@tetherto/wdk').default} wdk - The WDK instance.
 * @returns {Promise<{ normal: bigint, fast: bigint }>} The fee rates (octas).
 */
export function getFeeRates (wdk) {
  return wdk.getFeeRates(BLOCKCHAIN)
}

/**
 * Requests testnet APT from the faucet for an address and waits for the funding
 * transactions to settle.
 *
 * @param {string} address - The account address.
 * @param {bigint} [amountOctas] - The amount to request (default: 1 APT).
 * @returns {Promise<string[]>} The funding transaction hashes.
 */
export async function fundFromFaucet (address, amountOctas = 100000000n) {
  const res = await fetch(`${APTOS_FAUCET}/fund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, amount: Number(amountOctas) })
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Faucet request failed: ${res.status} - ${text.slice(0, 200)}`)
  }

  const data = await res.json()
  const hashes = Array.isArray(data) ? data : (data.txn_hashes || data.hashes || [])

  // Give the funding txns a moment to commit so a follow-up balance read reflects them.
  await waitForTransactions(hashes)

  return hashes
}

/**
 * Sends native APT to a recipient and waits for the transaction to commit.
 *
 * @param {object} account - The WDK Aptos account.
 * @param {string} recipient - The recipient's address.
 * @param {bigint} amountOctas - The amount in octas.
 * @returns {Promise<{ hash: string, fee: bigint, receipt: object | null }>} The result.
 */
export async function sendApt (account, recipient, amountOctas) {
  const { hash, fee } = await account.sendTransaction({ to: recipient, value: amountOctas })
  const receipt = await pollReceipt(account, hash)

  return { hash, fee, receipt }
}

/**
 * Transfers the demo FA (WDKT) to a recipient and waits for the transaction to
 * commit. Used for both "send" and "airdrop" — they are the same operation.
 *
 * @param {object} account - The WDK Aptos account.
 * @param {string} recipient - The recipient's address.
 * @param {bigint} amountBaseUnits - The amount in base units (6 decimals).
 * @returns {Promise<{ hash: string, fee: bigint, receipt: object | null }>} The result.
 */
export async function sendToken (account, recipient, amountBaseUnits) {
  const { hash, fee } = await account.transfer({ token: DEMO_FA_METADATA, recipient, amount: amountBaseUnits })
  const receipt = await pollReceipt(account, hash)

  return { hash, fee, receipt }
}

/**
 * Mints demo FA (WDKT) to the account's own address via the open-faucet `mint`
 * entry function, signing with the WDK-derived account keypair.
 *
 * @param {object} account - The WDK Aptos account.
 * @param {bigint} amountBaseUnits - The amount in base units (6 decimals).
 * @returns {Promise<{ hash: string, fee: bigint, receipt: object | null }>} The result.
 */
export async function mintToken (account, amountBaseUnits) {
  const to = await account.getAddress()

  const { hash, fee } = await mintFa({
    account,
    provider: APTOS_TESTNET,
    chainId: TESTNET_CHAIN_ID,
    moduleAddress: DEMO_FA_PUBLISHER,
    to,
    amount: amountBaseUnits
  })

  const receipt = await pollReceipt(account, hash)

  return { hash, fee, receipt }
}

/**
 * Quotes the fee for a native APT send without broadcasting.
 *
 * @param {object} account - The WDK Aptos account.
 * @param {string} recipient - The recipient's address.
 * @param {bigint} amountOctas - The amount in octas.
 * @returns {Promise<bigint>} The estimated fee (octas).
 */
export async function quoteApt (account, recipient, amountOctas) {
  const { fee } = await account.quoteSendTransaction({ to: recipient, value: amountOctas })
  return fee
}

/**
 * Polls for a transaction receipt until it is committed (has a `success`
 * field), giving up after a bounded number of attempts.
 *
 * @param {object} account - The WDK Aptos account.
 * @param {string} hash - The transaction hash.
 * @param {number} [attempts] - Max poll attempts.
 * @returns {Promise<object | null>} The committed receipt, or null if it never settled.
 */
export async function pollReceipt (account, hash, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const receipt = await account.getTransactionReceipt(hash)

    if (receipt && receipt.type === 'user_transaction') {
      return receipt
    }

    await sleep(1000)
  }

  return null
}

/** @private */
async function waitForTransactions (hashes, attempts = 15) {
  if (!hashes || hashes.length === 0) {
    await sleep(2000)
    return
  }

  for (let i = 0; i < attempts; i++) {
    const results = await Promise.all(hashes.map((h) => fetchTransaction(h)))

    if (results.every((r) => r && r.type === 'user_transaction')) {
      return
    }

    await sleep(1000)
  }
}

/** @private */
async function fetchTransaction (hash) {
  const res = await fetch(`${APTOS_TESTNET}/transactions/by_hash/${hash}`)

  if (res.status === 404) {
    return null
  }

  return res.ok ? res.json() : null
}

/** @private */
function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Formats a base-unit bigint as a human-readable decimal string.
 *
 * @param {bigint} value - The base-unit amount.
 * @param {number} decimals - The number of decimals.
 * @returns {string} The formatted amount.
 */
export function formatUnits (value, decimals) {
  const negative = value < 0n
  const abs = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '')

  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/**
 * Parses a human-readable decimal string into a base-unit bigint.
 *
 * @param {string} input - The decimal string (e.g. "1.5").
 * @param {number} decimals - The number of decimals.
 * @returns {bigint} The base-unit amount.
 * @throws {Error} If the input is not a valid non-negative decimal.
 */
export function parseUnits (input, decimals) {
  const trimmed = input.trim()

  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount: ${input}`)
  }

  const [whole, frac = ''] = trimmed.split('.')

  if (frac.length > decimals) {
    throw new Error(`Too many decimal places (max ${decimals})`)
  }

  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0'))
}
