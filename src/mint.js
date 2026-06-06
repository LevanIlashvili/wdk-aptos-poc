// Self-contained "mint" support for the demo fungible asset (WDKT).
//
// The shipped @tetherto/wdk-wallet-aptos module only encodes the two transfer
// payload shapes it ships (native APT and primary_fungible_store transfers) and
// does not expose its BCS primitives. Minting calls a custom entry function
// (`<publisher>::demo_fa::mint(to: address, amount: u64)`), so this file builds,
// signs, and submits that one transaction itself — using the WDK-derived account
// keypair for signing, and the same BCS/serialization rules as the wallet module
// (verified against its transaction.js/bcs.js). The audited module is untouched.

'use strict'

import { ed25519 } from '@noble/curves/ed25519'
// eslint-disable-next-line camelcase
import { sha3_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'

// sha3_256("APTOS::RawTransaction") — the RawTransaction signing-domain salt.
const RAW_TRANSACTION_SALT = sha3_256(new TextEncoder().encode('APTOS::RawTransaction'))

const PAYLOAD_ENTRY_FUNCTION = 2
const DEFAULT_MAX_GAS_AMOUNT = 100000n
const MAX_GAS_BUFFER = 2n
const TXN_EXPIRATION_SECS = 60

// --- minimal BCS writer (only what mint needs) -----------------------------

class Bcs {
  constructor () {
    this._bytes = []
  }

  u8 (value) {
    const v = Number(value)
    if (!Number.isInteger(v) || v < 0 || v > 0xff) {
      throw new Error(`u8 out of range: ${value}`)
    }
    this._bytes.push(v)
    return this
  }

  u64 (value) {
    let v = BigInt(value)
    if (v < 0n || v > 0xffffffffffffffffn) {
      throw new Error(`u64 out of range: ${value}`)
    }
    for (let i = 0; i < 8; i++) {
      this._bytes.push(Number(v & 0xffn))
      v >>= 8n
    }
    return this
  }

  uleb128 (value) {
    let v = value >>> 0
    do {
      let byte = v & 0x7f
      v >>>= 7
      if (v !== 0) byte |= 0x80
      this._bytes.push(byte)
    } while (v !== 0)
    return this
  }

  address (hex) {
    const raw = hex.startsWith('0x') ? hex.slice(2) : hex
    const padded = raw.padStart(64, '0')
    if (padded.length !== 64 || !/^[0-9a-fA-F]+$/.test(padded)) {
      throw new Error(`invalid address: ${hex}`)
    }
    for (let i = 0; i < 64; i += 2) {
      this._bytes.push(parseInt(padded.slice(i, i + 2), 16))
    }
    return this
  }

  string (str) {
    const utf8 = new TextEncoder().encode(str)
    this.uleb128(utf8.length)
    for (const b of utf8) this._bytes.push(b)
    return this
  }

  // length-prefixed bytes (BCS `vector<u8>`): a uleb128 length then the bytes.
  // Used for each entry-function argument (a serialized `vector<u8>` blob).
  bytes (arr) {
    this.uleb128(arr.length)
    for (const b of arr) this._bytes.push(b)
    return this
  }

  // raw bytes with NO length prefix. Used to inline an already-serialized
  // struct (e.g. the TransactionPayload inside a RawTransaction).
  raw (arr) {
    for (const b of arr) this._bytes.push(b)
    return this
  }

  toBytes () {
    return Uint8Array.from(this._bytes)
  }
}

// --- payload + raw txn encoding --------------------------------------------

// EntryFunction payload for `module::moduleName::functionName(to, amount)`
// where args are (address, u64) — exactly the demo_fa::mint signature.
function encodeMintPayload (module, moduleName, functionName, to, amount) {
  const addrArg = new Bcs().address(to).toBytes()
  const amountArg = new Bcs().u64(amount).toBytes()

  const bcs = new Bcs()
  bcs.uleb128(PAYLOAD_ENTRY_FUNCTION)
  bcs.address(module)
  bcs.string(moduleName)
  bcs.string(functionName)
  bcs.uleb128(0) // no type arguments
  bcs.uleb128(2) // two value arguments
  bcs.bytes(addrArg) // each arg is a length-prefixed BCS blob
  bcs.bytes(amountArg)
  return bcs.toBytes()
}

function encodeRawTransaction ({ sender, sequenceNumber, payload, maxGasAmount, gasUnitPrice, expirationTimestampSecs, chainId }) {
  const bcs = new Bcs()
  bcs.address(sender)
  bcs.u64(sequenceNumber)
  bcs.raw(payload) // payload is an already-serialized struct: inline, no length prefix
  bcs.u64(maxGasAmount)
  bcs.u64(gasUnitPrice)
  bcs.u64(expirationTimestampSecs)
  bcs.u8(chainId)
  return bcs.toBytes()
}

function buildSigningMessage (rawTxnBytes) {
  const msg = new Uint8Array(RAW_TRANSACTION_SALT.length + rawTxnBytes.length)
  msg.set(RAW_TRANSACTION_SALT, 0)
  msg.set(rawTxnBytes, RAW_TRANSACTION_SALT.length)
  return msg
}

// --- public API -------------------------------------------------------------

/**
 * Mints `amount` base units of the demo FA to `to`, signing with the WDK
 * account's keypair and submitting through the testnet REST API.
 *
 * @param {object} params
 * @param {object} params.account - The WDK Aptos account (provides keyPair + getAddress).
 * @param {string} params.provider - The fullnode REST base URL (…/v1).
 * @param {number} params.chainId - The chain id (testnet = 2).
 * @param {string} params.moduleAddress - The publisher address that owns demo_fa.
 * @param {string} params.to - The recipient address.
 * @param {bigint} params.amount - The amount in base units (6 decimals).
 * @returns {Promise<{ hash: string, fee: bigint }>}
 */
export async function mintFa ({ account, provider, chainId, moduleAddress, to, amount }) {
  const { privateKey, publicKey } = account.keyPair
  if (!privateKey) {
    throw new Error('Account is disposed; cannot mint.')
  }

  const sender = await account.getAddress()
  const payload = encodeMintPayload(moduleAddress, 'demo_fa', 'mint', to, amount)

  const jsonPayload = {
    type: 'entry_function_payload',
    function: `${moduleAddress}::demo_fa::mint`,
    type_arguments: [],
    arguments: [normalizeAddress(to), amount.toString()]
  }

  const sequenceNumber = await getSequenceNumber(provider, sender)
  const gasUnitPrice = await getGasUnitPrice(provider)

  // Simulate to size gas, then sign + submit with the derived max_gas_amount.
  const simGas = await simulate(provider, {
    sender, sequenceNumber, gasUnitPrice, payload: jsonPayload, publicKey
  })
  const maxGasAmount = simGas > 0n ? simGas * MAX_GAS_BUFFER : DEFAULT_MAX_GAS_AMOUNT
  const fee = simGas * gasUnitPrice

  const expiration = BigInt(Math.floor(Date.now() / 1000) + TXN_EXPIRATION_SECS)
  const rawTxn = encodeRawTransaction({
    sender, sequenceNumber, payload, maxGasAmount, gasUnitPrice, expirationTimestampSecs: expiration, chainId
  })
  const signature = ed25519.sign(buildSigningMessage(rawTxn), privateKey)

  const signed = {
    sender,
    sequence_number: sequenceNumber.toString(),
    max_gas_amount: maxGasAmount.toString(),
    gas_unit_price: gasUnitPrice.toString(),
    expiration_timestamp_secs: expiration.toString(),
    payload: jsonPayload,
    signature: {
      type: 'ed25519_signature',
      public_key: `0x${bytesToHex(publicKey)}`,
      signature: `0x${bytesToHex(signature)}`
    }
  }

  const res = await post(`${provider}/transactions`, signed)
  return { hash: res.hash, fee }
}

// --- REST helpers -----------------------------------------------------------

function normalizeAddress (address) {
  const raw = address.startsWith('0x') ? address.slice(2) : address
  return `0x${raw.padStart(64, '0')}`
}

async function getSequenceNumber (provider, address) {
  const res = await fetch(`${provider}/accounts/${address}`)
  if (res.status === 404) return 0n
  const data = await res.json()
  return BigInt(data.sequence_number)
}

async function getGasUnitPrice (provider) {
  const res = await fetch(`${provider}/estimate_gas_price`)
  const data = await res.json()
  return BigInt(data.gas_estimate)
}

async function simulate (provider, { sender, sequenceNumber, gasUnitPrice, payload, publicKey }) {
  const body = {
    sender,
    sequence_number: sequenceNumber.toString(),
    max_gas_amount: DEFAULT_MAX_GAS_AMOUNT.toString(),
    gas_unit_price: gasUnitPrice.toString(),
    expiration_timestamp_secs: (Math.floor(Date.now() / 1000) + TXN_EXPIRATION_SECS).toString(),
    payload,
    signature: { type: 'ed25519_signature', public_key: `0x${bytesToHex(publicKey)}`, signature: '0x' + '00'.repeat(64) }
  }
  const [result] = await post(`${provider}/transactions/simulate`, body)
  if (!result.success) {
    throw new Error(`Mint simulation failed: ${result.vm_status || 'unknown error'}`)
  }
  return BigInt(result.gas_used)
}

async function post (url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (!res.ok) {
    let message = res.statusText
    try { const d = JSON.parse(text); if (d.message) message = d.message } catch {}
    throw new Error(`Aptos RPC failed: ${res.status} - ${message}`)
  }
  return text ? JSON.parse(text) : null
}
