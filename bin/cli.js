#!/usr/bin/env node
'use strict'

import React from 'react'
import { render } from 'ink'

import App from '../src/app.js'

// Ink's interactive inputs require a TTY (raw mode). Fail with a clear message
// rather than an opaque React error if run without an interactive terminal.
if (!process.stdin.isTTY) {
  console.error('This wallet TUI needs an interactive terminal (TTY). Run it directly: `npm start`.')
  process.exit(1)
}

render(React.createElement(App))
