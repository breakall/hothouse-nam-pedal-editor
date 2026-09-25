# Hothouse NAM Editor

Browser-based editor for loading NAM captures into the three persistent slots
of a Hothouse NAM pedal and assigning the two non-bypass reverb positions.

The editor uses Web Serial, so direct pedal communication currently requires
desktop Chrome or Edge. It discovers the running firmware backend before it
prepares any captures:

- **A1 Nano-ReLU:** accepts compatible `.nam` files and converts them to NAMB
  in the browser, or accepts an already converted `.namb` file. A1 topology,
  activation, sample rate, weight count, version, binary checksum, and size are
  checked before transfer.
- **A2-Lite:** accepts `.nam` files, searches every model in a Tone3000
  `SlimmableContainer`, and extracts the first model matching the pedal's fixed
  A2-Lite kernel. Every relevant topology field and weight is checked.

Transfers use the firmware's `HNAM` protocol in 128-byte acknowledged chunks.
The editor verifies each returned offset and the final commit response, and
sends `HNAM CANCEL` after an interrupted or rejected in-progress transfer.
Slots A, B, and C correspond to the capture toggle's up, center, and down
positions. Existing slots can be replaced or cleared.

## Development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
npm test
npm run lint
```

`npm test` performs the production build, exercises A1 and A2 compatibility
and preparation, verifies multi-submodel A2 selection and transfer protocol
behavior, and checks the server-rendered editor page.
