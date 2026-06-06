// Ink (React-for-the-terminal) wallet TUI. Written with React.createElement (no
// JSX) so it runs directly under `node` with no build step.

'use strict'

import React, { useState, useEffect, useCallback } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import Spinner from 'ink-spinner'

import {
  createWallet,
  generateSeed,
  isValidSeed,
  loadAccount,
  getFeeRates,
  sendApt,
  sendToken,
  mintToken,
  formatUnits,
  parseUnits,
  APT_DECIMALS,
  DEMO_FA_DECIMALS,
  DEMO_FA_SYMBOL,
  TESTNET_CHAIN_ID
} from './wallet.js'

const h = React.createElement

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function Header () {
  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Text, { color: 'cyan', bold: true }, '  WDK · Aptos wallet PoC'),
    h(Text, { color: 'gray' }, `  testnet (chain id ${TESTNET_CHAIN_ID}) · powered by @tetherto/wdk + @tetherto/wdk-wallet-aptos`)
  )
}

function Field ({ label, value, color }) {
  return h(Box, null,
    h(Box, { width: 12 }, h(Text, { color: 'gray' }, label)),
    h(Text, { color: color || 'white' }, value)
  )
}

function StatusLine ({ status }) {
  if (!status) return null

  const color = status.kind === 'error' ? 'red' : status.kind === 'success' ? 'green' : 'yellow'
  const prefix = status.busy ? h(Text, { color }, h(Spinner, { type: 'dots' }), ' ') : null

  return h(Box, { marginTop: 1 }, prefix, h(Text, { color }, status.message))
}

// ---------------------------------------------------------------------------
// Seed entry screen
// ---------------------------------------------------------------------------

function SeedScreen ({ onReady }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  // 'typing' = editable text field active; 'generated' = a fresh seed is shown
  // for the user to confirm. Only one input handler is live at a time so the
  // text field and the key shortcuts never fight over the same keystroke.
  const [mode, setMode] = useState('typing')
  const [generated, setGenerated] = useState('')

  useInput((input, key) => {
    if (mode === 'typing') {
      // Ctrl+G generates a seed and switches to confirm mode.
      if (key.ctrl && input === 'g') {
        setGenerated(generateSeed())
        setError('')
        setMode('generated')
      }
      return
    }

    // mode === 'generated'
    if (key.return) {
      onReady(generated)
    } else if (input === 'e') {
      // Edit the generated seed in the text field instead of using it as-is.
      setValue(generated)
      setMode('typing')
    } else if (input === 'g') {
      setGenerated(generateSeed())
    }
  })

  const submit = (seed) => {
    const trimmed = seed.trim()
    if (!isValidSeed(trimmed)) {
      setError('Invalid BIP-39 seed phrase. Press Ctrl+G to generate a fresh one.')
      return
    }
    onReady(trimmed)
  }

  if (mode === 'generated') {
    return h(Box, { flexDirection: 'column' },
      h(Header),
      h(Text, null, '  Generated a fresh seed phrase — write it down:'),
      h(Box, { marginTop: 1, borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
        h(Text, { color: 'yellow' }, generated)
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: 'gray' }, '  [Enter] use it   [g] regenerate   [e] edit')
      ),
      h(Box, { marginTop: 1 }, h(Text, { color: 'gray' }, '  (testnet only — do not use a seed that holds real funds)'))
    )
  }

  return h(Box, { flexDirection: 'column' },
    h(Header),
    h(Text, null, '  Enter a BIP-39 seed phrase, or press ', h(Text, { color: 'cyan' }, 'Ctrl+G'), ' to generate one:'),
    h(Box, { marginTop: 1 },
      h(Text, { color: 'gray' }, '  > '),
      h(TextInput, { value, onChange: setValue, onSubmit: submit, placeholder: 'word word word ...' })
    ),
    error ? h(Box, { marginTop: 1 }, h(Text, { color: 'red' }, `  ${error}`)) : null,
    h(Box, { marginTop: 1 }, h(Text, { color: 'gray' }, '  (testnet only — do not use a seed that holds real funds)'))
  )
}

// ---------------------------------------------------------------------------
// Send form screen
// ---------------------------------------------------------------------------

function SendScreen ({ asset, account, onDone, onCancel }) {
  const decimals = asset === 'APT' ? APT_DECIMALS : DEMO_FA_DECIMALS
  const [step, setStep] = useState('recipient')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [status, setStatus] = useState(null)

  useInput((input, key) => {
    if (key.escape && step !== 'sending') onCancel()
  })

  const submitRecipient = (value) => {
    if (!value.trim().startsWith('0x')) {
      setStatus({ kind: 'error', message: 'Recipient must be a 0x address.' })
      return
    }
    setStatus(null)
    setStep('amount')
  }

  const submitAmount = async (value) => {
    let amountUnits
    try {
      amountUnits = parseUnits(value, decimals)
      if (amountUnits === 0n) throw new Error('Amount must be greater than zero.')
    } catch (err) {
      setStatus({ kind: 'error', message: err.message })
      return
    }

    setStep('sending')
    setStatus({ kind: 'info', busy: true, message: `Simulating, signing, and broadcasting ${asset} transfer...` })

    try {
      const send = asset === 'APT' ? sendApt : sendToken
      const { hash, fee, receipt } = await send(account, recipient.trim(), amountUnits)
      const ok = receipt && receipt.success
      onDone({
        kind: ok ? 'success' : 'error',
        message: ok
          ? `Sent ${value} ${asset}. tx ${hash} committed (fee ${formatUnits(fee, APT_DECIMALS)} APT).`
          : `Broadcast ${hash} but it did not commit successfully: ${receipt ? receipt.vm_status : 'no receipt'}.`
      })
    } catch (err) {
      onDone({ kind: 'error', message: `Send failed: ${err.message}` })
    }
  }

  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true }, `  Send ${asset}`),
    h(Box, { marginTop: 1 },
      h(Box, { width: 12 }, h(Text, { color: 'gray' }, '  to')),
      step === 'recipient'
        ? h(TextInput, { value: recipient, onChange: setRecipient, onSubmit: submitRecipient, placeholder: '0x...' })
        : h(Text, null, recipient)
    ),
    step !== 'recipient'
      ? h(Box, null,
          h(Box, { width: 12 }, h(Text, { color: 'gray' }, '  amount')),
          step === 'amount'
            ? h(TextInput, { value: amount, onChange: setAmount, onSubmit: submitAmount, placeholder: `0.0 ${asset}` })
            : h(Text, null, `${amount} ${asset}`)
        )
      : null,
    h(StatusLine, { status }),
    step !== 'sending'
      ? h(Box, { marginTop: 1 }, h(Text, { color: 'gray' }, '  Enter to continue · Esc to cancel'))
      : null
  )
}

// ---------------------------------------------------------------------------
// Dashboard screen
// ---------------------------------------------------------------------------

function Dashboard ({ wdk }) {
  const { exit } = useApp()
  const [index, setIndex] = useState(0)
  const [snapshot, setSnapshot] = useState(null)
  const [fees, setFees] = useState(null)
  const [status, setStatus] = useState({ kind: 'info', busy: true, message: 'Loading account...' })
  const [mode, setMode] = useState('dashboard') // 'dashboard' | 'send-apt' | 'send-token'

  const refresh = useCallback(async (accountIndex) => {
    setStatus({ kind: 'info', busy: true, message: `Loading account #${accountIndex}...` })
    try {
      const [snap, feeRates] = await Promise.all([loadAccount(wdk, accountIndex), getFeeRates(wdk)])
      setSnapshot(snap)
      setFees(feeRates)
      setStatus(null)
    } catch (err) {
      setStatus({ kind: 'error', message: `Load failed: ${err.message}` })
    }
  }, [wdk])

  useEffect(() => { refresh(index) }, [index, refresh])

  useInput((input, key) => {
    if (mode !== 'dashboard') return

    if (input === 'q') { wdk.dispose(); exit(); return }
    if (input === 'r') { refresh(index); return }
    if (input === 'n') { setIndex((i) => i + 1); return }
    if (input === 'p') { setIndex((i) => Math.max(0, i - 1)); return }
    if (input === 'm' && snapshot) { mint(); return }
    if (input === 'a' && snapshot) { setMode('send-apt'); return }
    if (input === 'd' && snapshot) { setMode('send-token'); return }
  })

  const mint = async () => {
    if (!snapshot) return
    setStatus({ kind: 'info', busy: true, message: `Minting 100 ${DEMO_FA_SYMBOL} to this account...` })
    try {
      const amount = 100n * 10n ** BigInt(DEMO_FA_DECIMALS)
      const { hash, receipt } = await mintToken(snapshot.account, amount)
      const ok = receipt && receipt.success
      setStatus({
        kind: ok ? 'success' : 'error',
        message: ok ? `Minted 100 ${DEMO_FA_SYMBOL}. tx ${hash}. Refreshing...` : `Mint ${hash} did not commit: ${receipt ? receipt.vm_status : 'no receipt'}.`
      })
      await refresh(index)
    } catch (err) {
      setStatus({ kind: 'error', message: `Mint failed: ${err.message}` })
    }
  }

  if (mode === 'send-apt' || mode === 'send-token') {
    return h(Box, { flexDirection: 'column' },
      h(Header),
      h(SendScreen, {
        asset: mode === 'send-apt' ? 'APT' : DEMO_FA_SYMBOL,
        account: snapshot.account,
        onCancel: () => setMode('dashboard'),
        onDone: async (result) => {
          setMode('dashboard')
          setStatus(result)
          await refresh(index)
        }
      })
    )
  }

  return h(Box, { flexDirection: 'column' },
    h(Header),
    h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
      h(Field, { label: '  account', value: `#${index}  (m/44'/637'/${index}'/0'/0')`, color: 'cyan' }),
      h(Field, { label: '  address', value: snapshot ? snapshot.address : '—' }),
      h(Field, { label: '  APT', value: snapshot ? `${formatUnits(snapshot.apt, APT_DECIMALS)} APT` : '—', color: 'green' }),
      h(Field, { label: `  ${DEMO_FA_SYMBOL}`, value: snapshot ? `${formatUnits(snapshot.token, DEMO_FA_DECIMALS)} ${DEMO_FA_SYMBOL}` : '—', color: 'green' }),
      h(Field, { label: '  fee rate', value: fees ? `${fees.normal} / ${fees.fast} octas (normal/fast)` : '—', color: 'gray' })
    ),
    h(StatusLine, { status }),
    h(Box, { marginTop: 1, flexDirection: 'column' },
      h(Text, { color: 'gray' }, '  [r] refresh   [n] next account   [p] prev account'),
      h(Text, { color: 'gray' }, `  [m] mint ${DEMO_FA_SYMBOL}  [a] send APT       [d] send/airdrop ${DEMO_FA_SYMBOL}   [q] quit`),
      h(Text, { color: 'gray' }, '  need APT for gas? fund the address at https://aptos.dev/network/faucet')
    )
  )
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export default function App () {
  const [wdk, setWdk] = useState(null)

  if (!wdk) {
    return h(SeedScreen, { onReady: (seed) => setWdk(createWallet(seed)) })
  }

  return h(Dashboard, { wdk })
}
