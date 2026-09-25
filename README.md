# Hothouse NAM Editor

Browser-based editor for loading NAM captures into the three persistent slots
of a Hothouse NAM pedal and assigning the two non-bypass reverb positions.

The editor uses Web Serial, so direct pedal communication currently requires
desktop Chrome or Edge. It accepts Tone3000 `.nam` downloads, searches every
model in a `SlimmableContainer`, and extracts the first model matching the
pedal's fixed A2-Lite kernel. Every relevant topology field and weight is
checked before transfer. The editor connects only to the current `a2_lite`
firmware backend.

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

`npm test` performs the production build, exercises A2-Lite compatibility and
preparation, and verifies multi-submodel selection and transfer protocol
behavior.
